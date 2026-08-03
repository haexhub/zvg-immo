// Drains the local raw-archive outbox into Supabase Storage: every
// `artifact_blobs` row without `uploaded_at` gets uploaded, then marked uploaded
// and deleted locally. Only after a *confirmed* upload — so a transient
// Storage outage just leaves blobs in the outbox for the next run to retry,
// never losing bytes. Best-effort like raw-archive.ts: never throws, no-op
// without NUXT_DATABASE_URL, Supabase config, or a configured bucket.

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getPool } from './db'
import { getServiceClient } from './supabase'

function bucketName(): string | null {
  return (useRuntimeConfig().storageBucket as string | undefined) || null
}

function outboxDir(): string {
  return (useRuntimeConfig().rawOutboxDir as string | undefined) || join(process.cwd(), '.raw_outbox')
}

interface PendingBlob {
  content_hash: string
  s3_key: string
  content_type: string
}

export interface DrainResult {
  uploaded: number
  failed: number
  missing: number
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Uploads every not-yet-uploaded outbox blob to Supabase Storage. No-op
 *  (returns zeros) without DB, Supabase config, or a bucket name. Never
 *  throws. */
export async function drainOutbox(): Promise<DrainResult> {
  const db = getPool()
  if (!db) return { uploaded: 0, failed: 0, missing: 0 }
  const bucket = bucketName()
  if (!bucket) return { uploaded: 0, failed: 0, missing: 0 }
  const supabase = getServiceClient()
  if (!supabase) return { uploaded: 0, failed: 0, missing: 0 }

  let uploaded = 0
  let failed = 0
  let missing = 0
  try {
    const { rows } = await db.query<PendingBlob>(
      'SELECT content_hash, s3_key, content_type FROM artifact_blobs WHERE uploaded_at IS NULL',
    )
    if (rows.length === 0) return { uploaded: 0, failed: 0, missing: 0 }

    const dir = outboxDir()
    for (const row of rows) {
      try {
        let body: Buffer
        try {
          body = await readFile(join(dir, row.s3_key))
        } catch (err) {
          if (isMissingFileError(err)) {
            missing++
            continue
          }
          throw err
        }
        const { error } = await supabase.storage
          .from(bucket)
          .upload(row.s3_key, body, { contentType: row.content_type, upsert: true })
        if (error) throw new Error(error.message)
        await db.query('UPDATE artifact_blobs SET uploaded_at = now() WHERE content_hash = $1', [
          row.content_hash,
        ])
        await rm(join(dir, row.s3_key), { force: true })
        uploaded++
      } catch (err) {
        console.warn(`[storage-uploader] upload failed for ${row.content_hash}: ${(err as Error).message}`)
        failed++
      }
    }
    if (missing > 0) {
      console.warn(
        `[storage-uploader] ${missing} pending blob(s) have no local outbox file; leaving rows pending for a future recrawl`,
      )
    }
  } catch (err) {
    console.warn(`[storage-uploader] drain failed: ${(err as Error).message}`)
  }
  return { uploaded, failed, missing }
}
