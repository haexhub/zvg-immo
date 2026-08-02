// Crawls every registered region and writes results to the persistent list cache
// so /api/auctions can serve requests without hitting upstream portals on each call.
//
// Triggered hourly by the scheduled task config in nuxt.config.ts and once on
// server startup via server/plugins/refresh-bootstrap.ts. Each region is only
// re-crawled when its cache is older than its portal's interval
// (server/crawlers/crawl-cadence.ts), so hourly ticks keep robust portals
// fresh without over-polling rate-limited ones.

import { crawlSingle, ensureEnabledCountriesLoaded, listRegions } from '../crawlers/registry'
import { regionRefreshIntervalMs } from '../crawlers/crawl-cadence'
import { matchAlerts } from '../utils/alert-matching'
import { recordObservations } from '../utils/history'
import { archiveAuction } from '../utils/raw-archive'
import { ensureAuctionIdentity } from '../utils/current-auctions'
import { writeAuctionCrawlFetchState } from '../utils/auction-fetch-state'
import { regionListCacheAgeMs, writeListCache } from '../utils/list-cache'
import { drainOutbox } from '../utils/storage-uploader'
import { runExclusiveTask, throwIfTaskAborted } from '../utils/exclusive-task'

export default defineTask({
  meta: {
    name: 'refresh',
    description: 'Crawl all registered regions and persist results to the list cache.',
  },
  async run() {
    return await runExclusiveTask('refresh', runRefresh)
  },
})

async function runRefresh(signal: AbortSignal) {
  const startedAt = Date.now()
  const capturedAt = new Date(startedAt).toISOString()
  await ensureEnabledCountriesLoaded()
  const regions = listRegions()
  console.log(`[refresh] start — ${regions.length} regions`)

  let ok = 0
  let failed = 0
  const failureMessages: string[] = []
  let skipped = 0
  let cursor = 0

  async function worker() {
    while (cursor < regions.length) {
      throwIfTaskAborted(signal)
      const idx = cursor++
      const r = regions[idx]
      if (!r) continue
      // Background cadence: skip a region whose cache is still fresh enough for
      // its portal's interval (rate-limit / IP-ban protection). A cold region
      // (age === null) or one past its interval is crawled. The hourly cron
      // thus keeps robust portals current while sparing sensitive ones.
      const age = await regionListCacheAgeMs(r.country, r.code)
      if (age !== null && age < regionRefreshIntervalMs(r.platforms.map((p) => p.id))) {
        skipped++
        continue
      }
      try {
        const result = await crawlSingle({
          country: r.country,
          region: r.code,
          immobilienOnly: true,
          enrichDetails: false,
        })
        throwIfTaskAborted(signal)
        await writeListCache(r.country, r.code, result)
        // Must precede archiveAuction below: artifact_captures/artifact_versions
        // carry an FK on (platform, external_id) -> auctions, so the identity
        // has to exist before the first archive write for this auction.
        await ensureAuctionIdentity(result.auctions)
        await writeAuctionCrawlFetchState(result.auctions)
        // History and raw-archive writes are part of a successful crawl: their
        // failures propagate into this region's visible failure result.
        // Alert delivery remains independently fault-tolerant.
        await recordObservations(result, capturedAt)
        await matchAlerts(r.country, r.code, result)
        for (const a of result.auctions) {
          throwIfTaskAborted(signal)
          await archiveAuction(a, capturedAt)
        }
        ok++
      } catch (err) {
        const message = `${r.country}/${r.code}: ${(err as Error).message}`
        console.warn(`[refresh] ${message}`)
        failureMessages.push(message)
        failed++
      }
    }
  }

  await Promise.all(Array.from({ length: 4 }, worker))

  // Drain the raw-archive outbox to Supabase Storage once per run
  // (best-effort, never throws) — this is the single scheduled trigger
  // point for the uploader (see server/utils/storage-uploader.ts).
  const upload = await drainOutbox()
  if (upload.uploaded > 0 || upload.failed > 0) {
    console.log(`[refresh] archive upload: ${upload.uploaded} ok, ${upload.failed} failed`)
  }
  if (upload.failed > 0) {
    failureMessages.push(`${upload.failed} Roharchiv-Upload(s) fehlgeschlagen`)
  }

  const durationMs = Date.now() - startedAt
  console.log(
    `[refresh] done in ${(durationMs / 1000).toFixed(0)}s — ${ok} ok, ${failed} failed, ${skipped} skipped`,
  )
  // Individual regions fail routinely and for reasons outside our control (BOE's
  // captcha, an upstream 429 — see server/crawlers/crawl-cadence.ts). Throwing
  // on any of them would mark practically every hourly run as failed and make
  // the signal worthless. Only a run that crawled nothing at all is a real
  // outage; partial failures stay in the per-region warnings logged above.
  if (failureMessages.length > 0) {
    console.warn(
      `[refresh] ${failureMessages.length} region(s) failed: ${failureMessages.slice(0, 20).join('; ')}`,
    )
  }
  if (ok === 0 && failed > 0) {
    throw new Error(`Refresh komplett fehlgeschlagen (${failed} Quellen): ${failureMessages.slice(0, 20).join('; ')}`)
  }
  return { result: { ok, failed, skipped, durationMs } }
}
