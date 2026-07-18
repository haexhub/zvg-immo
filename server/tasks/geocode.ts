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
import { enrichInBatches as enrichBidditDetails, formatVerkehrswertText } from '../crawlers/biddit/detail'
import { geocodeAddress } from '../utils/geocode'
import {
  cacheKey,
  readVerkehrswertCache,
  writeVerkehrswertCache,
  type VerkehrswertCache,
} from '../utils/verkehrswert-cache'

// Guards against overlapping runs: a cold-start bootstrap run can take ~40 min
// and would otherwise race a cron-triggered run of the same task (duplicate
// Nominatim traffic, concurrent verkehrswert cache writes).
let running = false

export default defineTask({
  meta: {
    name: 'geocode',
    description: 'Crawl all registered regions and geocode addresses missing from the cache.',
  },
  async run() {
    if (running) {
      console.warn('[geocode] previous run still in progress — skipping')
      return { result: undefined }
    }
    running = true
    try {
      return await runGeocode()
    } finally {
      running = false
    }
  },
})

async function runGeocode() {
    const startedAt = Date.now()
    console.log('[geocode] start')

    const result = await crawlAll({ immobilienOnly: true, enrichDetails: false })
    // Listings whose crawler already supplied coordinates never need the geocoder.
    const withAddress = result.auctions.filter((a) => a.address && (a.lat == null || a.lng == null))
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
        const point = await geocodeAddress(a.address, a.country, { fetchMissing: true })
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
}

async function enrichAtVerkehrswert(
  auctions: Auction[],
  cache: VerkehrswertCache,
): Promise<{ added: number; errors: number }> {
  const atAuctions = auctions.filter((a) => a.platform === 'at-edikte')
  if (atAuctions.length === 0) return { added: 0, errors: 0 }

  const toFetch = atAuctions.filter((a) => !(cacheKey(a.platform, a.externalId) in cache))
  if (toFetch.length === 0) {
    console.log(`[geocode] verkehrswert(at): ${atAuctions.length} entries, all cached`)
    return { added: 0, errors: 0 }
  }
  console.log(
    `[geocode] verkehrswert(at): fetching ${toFetch.length}/${atAuctions.length} missing details`,
  )

  let added = 0
  const result = await enrichAtDetails(toFetch, (auction, info) => {
    cache[cacheKey('at-edikte', auction.externalId)] = {
      marketValueEur: info.schaetzwertEur,
      marketValueText: info.schaetzwertText,
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

  // Also refetch cached nulls once: before the startingPrice fallback existed,
  // every lot cached null (estimatedPrice is a placeholder platform-wide), and
  // first-write-wins would keep those nulls forever. The `retried` marker keeps
  // this a one-time backfill — lots that genuinely have no price don't get
  // re-fetched on every run.
  const toFetch = beAuctions.filter((a) => {
    const hit = cache[cacheKey(a.platform, a.externalId)]
    return hit == null || (hit.marketValueEur == null && !hit.retried)
  })
  if (toFetch.length === 0) {
    console.log(`[geocode] verkehrswert(be): ${beAuctions.length} entries, all cached`)
    return { added: 0, errors: 0 }
  }
  console.log(
    `[geocode] verkehrswert(be): fetching ${toFetch.length}/${beAuctions.length} missing details`,
  )

  let added = 0
  const result = await enrichBidditDetails(toFetch, (auction, info) => {
    cache[cacheKey('biddit', auction.externalId)] = {
      marketValueEur: info.estimatedPrice,
      marketValueText: formatVerkehrswertText(info),
      ...(info.estimatedPrice == null ? { retried: true } : {}),
    }
    added++
  })
  return { added, errors: result.errors }
}
