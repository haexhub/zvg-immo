// Crawls every registered region and resolves missing addresses to lat/lng via
// Nominatim. Idempotent: addresses already in the disk cache are skipped, so
// the first run is slow (~40 min for ~2200 cold lookups at 1 req/s) and
// subsequent runs finish in seconds.
//
// Triggered by the scheduled task config in nuxt.config.ts and once on server
// startup via server/plugins/geocode-bootstrap.ts.

import type { Auction } from '~/types/auction'
import { crawlAll } from '../crawlers/registry'
import { enrichInBatches as enrichAtDetails } from '../crawlers/at/detail'
import { geocodeAddress } from '../utils/geocode'
import {
  cacheKey,
  readVerkehrswertCache,
  writeVerkehrswertCache,
  type VerkehrswertCache,
} from '../utils/verkehrswert-cache'

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

    // AT-Edikte hides Schätzwert on the per-Edikt detail page, so it's null on
    // the listing path the API uses. Enrich missing entries here and persist
    // them so the API can overlay the value read-only.
    const verkehrswert = await enrichAtVerkehrswert(result.auctions)

    const durationMs = Date.now() - startedAt
    console.log(
      `[geocode] done in ${(durationMs / 1000).toFixed(0)}s · geocoded=${geocoded} failed=${failed} · verkehrswert(at)=${verkehrswert.added} added/${verkehrswert.errors} err`,
    )

    return {
      result: {
        processed,
        geocoded,
        failed,
        verkehrswertAdded: verkehrswert.added,
        verkehrswertErrors: verkehrswert.errors,
        durationMs,
      },
    }
  },
})

async function enrichAtVerkehrswert(
  auctions: Auction[],
): Promise<{ added: number; errors: number }> {
  const atAuctions = auctions.filter((a) => a.platform === 'at-edikte')
  if (atAuctions.length === 0) return { added: 0, errors: 0 }

  const cache: VerkehrswertCache = { ...(await readVerkehrswertCache()) }
  const toFetch = atAuctions.filter((a) => !(cacheKey(a.platform, a.zvgId) in cache))
  if (toFetch.length === 0) {
    console.log(`[geocode] verkehrswert(at): ${atAuctions.length} entries, all cached`)
    return { added: 0, errors: 0 }
  }
  console.log(
    `[geocode] verkehrswert(at): fetching ${toFetch.length}/${atAuctions.length} missing details`,
  )

  let added = 0
  const result = await enrichAtDetails(toFetch, (auction, info) => {
    cache[cacheKey('at-edikte', auction.zvgId)] = {
      verkehrswertEur: info.schaetzwertEur,
      verkehrswertText: info.schaetzwertText,
    }
    added++
  })
  if (added > 0) await writeVerkehrswertCache(cache)
  return { added, errors: result.errors }
}
