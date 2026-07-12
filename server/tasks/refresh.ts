// Crawls every registered region and writes results to the persistent list cache
// so /api/auctions can serve requests without hitting upstream portals on each call.
//
// Triggered by the scheduled task config in nuxt.config.ts (twice daily) and
// once on server startup via server/plugins/refresh-bootstrap.ts.

import { crawlSingle, listRegions } from '../crawlers/registry'
import { writeListCache } from '../utils/list-cache'

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
  const regions = listRegions()
  console.log(`[refresh] start — ${regions.length} regions`)

  let ok = 0
  let failed = 0
  let cursor = 0

  async function worker() {
    while (cursor < regions.length) {
      const idx = cursor++
      const r = regions[idx]
      if (!r) continue
      try {
        const result = await crawlSingle({
          country: r.country,
          region: r.code,
          immobilienOnly: true,
          enrichDetails: false,
        })
        await writeListCache(r.country, r.code, result)
        ok++
      } catch (err) {
        console.warn(`[refresh] ${r.country}/${r.code}: ${(err as Error).message}`)
        failed++
      }
    }
  }

  await Promise.all(Array.from({ length: 4 }, worker))

  const durationMs = Date.now() - startedAt
  console.log(`[refresh] done in ${(durationMs / 1000).toFixed(0)}s — ${ok} ok, ${failed} failed`)
  return { result: { ok, failed, durationMs } }
}
