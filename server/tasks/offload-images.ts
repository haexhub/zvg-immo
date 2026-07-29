// Moves the photos of ended auctions out of the local image cache and into the
// images bucket, so the server volume stops growing with every past auction.
// Nothing is lost: /api/auction-image/[platform]/[id]/[name] already falls back
// to a redirect at the bucket's public URL once the local file is gone.
//
// Same upload-then-delete contract as server/utils/storage-uploader.ts: a local
// file is only removed after a *confirmed* upload, so a Storage outage just
// leaves it on disk for the next run. The whole task is a hard no-op while no
// images bucket is configured — deleting then would destroy the only copy.

import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getPool } from '~/server/utils/db'
import { imagesBucketConfigured, uploadImage } from '~/server/utils/image-storage'
import { isSafePathSegment } from '~/server/utils/path-segment'
import { runExclusiveTask, throwIfTaskAborted } from '~/server/utils/exclusive-task'
import { recordTaskRunEnd, recordTaskRunStart } from '~/server/utils/task-runs'
import { cacheKey } from '~/server/utils/verkehrswert-cache'

const IMAGES_DIR = join(process.cwd(), '.cache_zvg', 'images')

// Recently ended auctions keep their fast local copy: a bidder looking at last
// week's result should not pay a redirect per photo. Purely a latency trade —
// correctness-wise any uploaded file is safe to drop immediately.
const OFFLOAD_AFTER_DAYS = 30

export interface OffloadImagesResult {
  /** `<platform>/<externalId>` directories considered ended. */
  auctionsOffloaded: number
  uploaded: number
  /** Local files removed after a confirmed upload. */
  removed: number
  failed: number
  freedBytes: number
  durationMs: number
}

export default defineTask({
  meta: {
    name: 'offload-images',
    description: 'Upload ended auctions\' cached photos to the images bucket and drop the local copies.',
  },
  async run() {
    return await runExclusiveTask('offload-images', async (signal) => {
      await recordTaskRunStart('offload-images')
      try {
        const result = await runOffloadImages(signal)
        await recordTaskRunEnd('offload-images', {
          result: { ...result },
          warning: result.failed > 0
            ? `${result.failed} Datei(en) konnten nicht ausgelagert werden — bleiben lokal liegen.`
            : null,
        })
        return { result }
      } catch (err) {
        await recordTaskRunEnd('offload-images', { error: (err as Error).message })
        throw err
      }
    })
  },
})

/** Auctions whose date has passed long enough to offload, keyed platform:id. */
async function endedBefore(cutoffIso: string): Promise<Set<string>> {
  const db = getPool()
  if (!db) return new Set()
  const { rows } = await db.query<{ platform: string; external_id: string }>(
    `SELECT platform, external_id FROM auctions
     WHERE auction_date_iso IS NOT NULL AND auction_date_iso < $1`,
    [cutoffIso],
  )
  return new Set(rows.map((row) => cacheKey(row.platform, row.external_id)))
}

/** Auctions still present in the serving table, keyed platform:id. */
async function knownAuctions(): Promise<Set<string>> {
  const db = getPool()
  if (!db) return new Set()
  const { rows } = await db.query<{ platform: string; external_id: string }>(
    'SELECT platform, external_id FROM auctions',
  )
  return new Set(rows.map((row) => cacheKey(row.platform, row.external_id)))
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

export async function runOffloadImages(signal?: AbortSignal): Promise<OffloadImagesResult> {
  const startedAt = Date.now()
  const result: OffloadImagesResult = {
    auctionsOffloaded: 0,
    uploaded: 0,
    removed: 0,
    failed: 0,
    freedBytes: 0,
    durationMs: 0,
  }

  // Must be the first check: without a bucket the local file is the only copy.
  if (!imagesBucketConfigured()) {
    console.warn('[offload-images] no images bucket configured — nothing offloaded')
    result.durationMs = Date.now() - startedAt
    return result
  }
  // Without the serving table there is no way to tell an ended auction from a
  // running one, and every directory would look orphaned — see below. Refuse
  // rather than drain the whole cache on a guess.
  if (!getPool()) {
    console.warn('[offload-images] no database configured — nothing offloaded')
    result.durationMs = Date.now() - startedAt
    return result
  }

  const cutoff = new Date(startedAt - OFFLOAD_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const [ended, known] = await Promise.all([endedBefore(cutoff), knownAuctions()])

  for (const platform of await listDirs(IMAGES_DIR)) {
    if (!isSafePathSegment(platform)) continue
    for (const externalId of await listDirs(join(IMAGES_DIR, platform))) {
      throwIfTaskAborted(signal)
      if (!isSafePathSegment(externalId)) continue
      const key = cacheKey(platform, externalId)
      // An auction the serving table no longer knows about can never be shown
      // from the local cache again, so it is offloadable regardless of date.
      if (!ended.has(key) && known.has(key)) continue

      const dir = join(IMAGES_DIR, platform, externalId)
      let offloadedHere = 0
      for (const name of await readdir(dir).catch(() => [])) {
        throwIfTaskAborted(signal)
        const filePath = join(dir, name)
        try {
          const [bytes, info] = await Promise.all([readFile(filePath), stat(filePath)])
          if (!await uploadImage(bytes, `${platform}/${externalId}/${name}`)) {
            result.failed++
            continue
          }
          result.uploaded++
          await rm(filePath, { force: true })
          result.removed++
          result.freedBytes += info.size
          offloadedHere++
        } catch (err) {
          result.failed++
          console.warn(`[offload-images] ${platform}/${externalId}/${name}: ${(err as Error).message}`)
        }
      }
      if (offloadedHere > 0) result.auctionsOffloaded++
      // Drop the now-empty directory; rmdir fails harmlessly if files remain.
      await rm(dir, { recursive: false }).catch(() => undefined)
    }
  }

  result.durationMs = Date.now() - startedAt
  console.log(
    `[offload-images] done in ${(result.durationMs / 1000).toFixed(0)}s — `
    + `${result.removed} file(s) from ${result.auctionsOffloaded} auction(s), `
    + `${(result.freedBytes / 1024 / 1024).toFixed(0)} MB freed, ${result.failed} failed`,
  )
  return result
}
