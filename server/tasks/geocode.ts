// Crawls every registered region and resolves missing addresses to lat/lng via
// Nominatim. Idempotent: addresses already in the disk cache are skipped, so
// the first run is slow (~40 min for ~2200 cold lookups at 1 req/s) and
// subsequent runs finish in seconds.
//
// Triggered by the scheduled task config in nuxt.config.ts and once on server
// startup via server/plugins/geocode-bootstrap.ts.

import { crawlAll } from '../crawlers/registry'
import { geocodeAddress } from '../utils/geocode'

export default defineTask({
  meta: {
    name: 'geocode',
    description: 'Crawl all registered regions and geocode addresses missing from the cache.',
  },
  async run() {
    const startedAt = Date.now()
    console.log('[geocode] start')

    const result = await crawlAll({ immobilienOnly: true, enrichDetails: false })
    const withAddress = result.auctions.filter((a) => a.adresse)
    console.log(
      `[geocode] crawled ${result.auctions.length} auctions (${withAddress.length} with address)`,
    )

    let processed = 0
    let geocoded = 0
    let failed = 0
    const startGeo = Date.now()
    for (const a of withAddress) {
      processed++
      try {
        const point = await geocodeAddress(a.adresse, a.country, { fetchMissing: true })
        if (point) geocoded++
      } catch {
        failed++
      }
      if (processed % 100 === 0 || processed === withAddress.length) {
        const rate = processed / Math.max(1, (Date.now() - startGeo) / 1000)
        console.log(
          `[geocode] ${processed}/${withAddress.length} · ${geocoded} hit · ${failed} err · ${rate.toFixed(1)}/s`,
        )
      }
    }

    const durationMs = Date.now() - startedAt
    console.log(
      `[geocode] done in ${(durationMs / 1000).toFixed(0)}s · geocoded=${geocoded} failed=${failed}`,
    )

    return { result: { processed, geocoded, failed, durationMs } }
  },
})
