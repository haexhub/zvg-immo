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
import { enrichInBatches as enrichBidditDetails } from '../crawlers/biddit/detail'
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

    // AT-Edikte and Biddit both hide their Schätzwert / estimatedPrice on the
    // listing path the API uses. Enrich missing entries here and persist them
    // so the API can overlay the value read-only. Load the cache once and
    // share it — two concurrent writers would each rebuild the file from their
    // own local read, silently dropping the sibling's entries.
    const vwCache: VerkehrswertCache = { ...(await readVerkehrswertCache()) }
    const [vwAt, vwBe] = await Promise.all([
      enrichAtVerkehrswert(result.auctions, vwCache),
      enrichBidditVerkehrswert(result.auctions, vwCache),
    ])
    const vwAdded = vwAt.added + vwBe.added
    const vwErrors = vwAt.errors + vwBe.errors
    if (vwAdded > 0) await writeVerkehrswertCache(vwCache)

    const durationMs = Date.now() - startedAt
    console.log(
      `[geocode] done in ${(durationMs / 1000).toFixed(0)}s · geocoded=${geocoded} failed=${failed} · verkehrswert(at)=${vwAt.added}/${vwAt.errors} · verkehrswert(be)=${vwBe.added}/${vwBe.errors}`,
    )

    return {
      result: {
        processed,
        geocoded,
        failed,
        verkehrswertAdded: vwAdded,
        verkehrswertErrors: vwErrors,
        durationMs,
      },
    }
  },
})

async function enrichAtVerkehrswert(
  auctions: Auction[],
  cache: VerkehrswertCache,
): Promise<{ added: number; errors: number }> {
  const atAuctions = auctions.filter((a) => a.platform === 'at-edikte')
  if (atAuctions.length === 0) return { added: 0, errors: 0 }

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
  return { added, errors: result.errors }
}

// Biddit's estimatedPrice is on the detail (BFF) JSON but not on the search
// listing the /api/auctions crawl uses. Mirror the AT flow: fetch once per new
// auction, store null when the field is a placeholder so we don't re-fetch it
// every run.
async function enrichBidditVerkehrswert(
  auctions: Auction[],
  cache: VerkehrswertCache,
): Promise<{ added: number; errors: number }> {
  const beAuctions = auctions.filter((a) => a.platform === 'biddit')
  if (beAuctions.length === 0) return { added: 0, errors: 0 }

  const toFetch = beAuctions.filter((a) => !(cacheKey(a.platform, a.zvgId) in cache))
  if (toFetch.length === 0) {
    console.log(`[geocode] verkehrswert(be): ${beAuctions.length} entries, all cached`)
    return { added: 0, errors: 0 }
  }
  console.log(
    `[geocode] verkehrswert(be): fetching ${toFetch.length}/${beAuctions.length} missing details`,
  )

  let added = 0
  const result = await enrichBidditDetails(toFetch, (auction, info) => {
    cache[cacheKey('biddit', auction.zvgId)] = {
      verkehrswertEur: info.estimatedPrice,
      verkehrswertText:
        info.estimatedPrice != null
          ? `${info.estimatedPrice.toLocaleString('de-DE')} €`
          : null,
    }
    added++
  })
  return { added, errors: result.errors }
}
