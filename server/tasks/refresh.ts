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
import { regionListCacheAgeMs, writeListCache } from '../utils/list-cache'
import { drainOutbox } from '../utils/storage-uploader'

let running = false

export default defineTask({
  meta: {
    name: 'refresh',
    description: 'Crawl all registered regions and persist results to the list cache.',
  },
  async run() {
    if (running) {
      console.warn('[refresh] previous run still in progress — skipping')
      return { result: undefined }
    }
    running = true
    try {
      return await runRefresh()
    } finally {
      running = false
    }
  },
})

async function runRefresh() {
  const startedAt = Date.now()
  const capturedAt = new Date(startedAt).toISOString()
  await ensureEnabledCountriesLoaded()
  const regions = listRegions()
  console.log(`[refresh] start — ${regions.length} regions`)

  let ok = 0
  let failed = 0
  let skipped = 0
  let cursor = 0

  async function worker() {
    while (cursor < regions.length) {
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
        await writeListCache(r.country, r.code, result)
        // Best-effort history + alert-matching + raw-archive writes — must
        // never fail the crawl (all three already swallow their own errors
        // internally).
        await recordObservations(result, capturedAt)
        await matchAlerts(r.country, r.code, result)
        for (const a of result.auctions) {
          await archiveAuction(a, capturedAt)
        }
        ok++
      } catch (err) {
        console.warn(`[refresh] ${r.country}/${r.code}: ${(err as Error).message}`)
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

  const durationMs = Date.now() - startedAt
  console.log(
    `[refresh] done in ${(durationMs / 1000).toFixed(0)}s — ${ok} ok, ${failed} failed, ${skipped} skipped`,
  )
  return { result: { ok, failed, skipped, durationMs } }
}
