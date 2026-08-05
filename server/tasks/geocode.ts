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
import { activeGeocoderProvider, geocodeAddress, geocodeStatus } from '../utils/geocode'
import { writeAuctionDetails } from '../utils/auction-details'
import { applyAuctionExtraction } from '../utils/auction-extraction'
import { mergeStoredAuction } from '../utils/auction-merge'
import {
  ensureAuctionIdentity,
  recordGeocodeAttempts,
  upsertCurrentAuctions,
  type GeocodeAttempt,
} from '../utils/current-auctions'
import { readAuctionRecordMap } from '../utils/auction-record'
import {
  cacheKey,
  readVerkehrswertCache,
  writeVerkehrswertCache,
  type VerkehrswertCache,
} from '../utils/verkehrswert-cache'
import { runExclusiveTask, throwIfTaskAborted } from '../utils/exclusive-task'

// Guards against overlapping runs: a cold-start bootstrap run can take ~40 min
// and would otherwise race a cron-triggered run of the same task (duplicate
// Nominatim traffic, concurrent verkehrswert cache writes).
export default defineTask({
  meta: {
    name: 'geocode',
    description: 'Crawl all registered regions and geocode addresses missing from the cache.',
  },
  async run() {
    return await runExclusiveTask('geocode', runGeocode)
  },
})

async function runGeocode(signal: AbortSignal) {
    const startedAt = Date.now()
    console.log('[geocode] start')

    const result = await crawlAll({ immobilienOnly: true, enrichDetails: false, signal })
    // Listings whose crawler already supplied coordinates never need the geocoder.
    const withAddress = result.auctions.filter((a) => a.address && (a.lat == null || a.lng == null))
    console.log(
      `[geocode] crawled ${result.auctions.length} auctions (${withAddress.length} with address)`,
    )

    let processed = 0
    let geocoded = 0
    let failed = 0
    const provider = activeGeocoderProvider()
    const attempts: GeocodeAttempt[] = []
    const startGeo = Date.now()
    for (const a of withAddress) {
      throwIfTaskAborted(signal)
      processed++
      try {
        const point = await geocodeAddress(a.address, a.country, { fetchMissing: true })
        if (point) {
          a.lat = point.lat
          a.lng = point.lng
          geocoded++
        }
      } catch {
        failed++
      }
      // Recorded regardless of outcome: "never attempted" vs "attempted, still
      // unresolved" is only distinguishable in the DB once this run stamps it
      // (see WP-3) — 'pending' below means the cache still has un-queried
      // variants (e.g. the failure cooldown skipped them this run).
      const result = await geocodeStatus(a.address, a.country)
      attempts.push({ platform: a.platform, externalId: a.externalId, result, provider })
      if (processed % 100 === 0 || processed === withAddress.length) {
        const rate = processed / Math.max(1, (Date.now() - startGeo) / 1000)
        console.log(
          `[geocode] ${processed}/${withAddress.length} · ${geocoded} hit · ${failed} err · ${rate.toFixed(1)}/s`,
        )
      }
    }
    await recordGeocodeAttempts(attempts, new Date().toISOString())

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

    const persistedCoordinates = await persistGeocodedAuctions(
      result.auctions.filter((a) => a.lat != null && a.lng != null),
      signal,
    )

    const durationMs = Date.now() - startedAt
    console.log(
      `[geocode] done in ${(durationMs / 1000).toFixed(0)}s · geocoded=${geocoded} persisted=${persistedCoordinates} failed=${failed} · verkehrswert(at)=${vwAt.added}/${vwAt.errors} · verkehrswert(be)=${vwBe.added}/${vwBe.errors}`,
    )

    return {
      result: {
        processed,
        geocoded,
        persistedCoordinates,
        failed,
        verkehrswertAdded: vwAdded,
        verkehrswertErrors: vwErrors,
        durationMs,
      },
    }
}

async function persistGeocodedAuctions(auctions: Auction[], signal: AbortSignal): Promise<number> {
  if (auctions.length === 0) return 0
  await ensureAuctionIdentity(auctions)
  const records = await readAuctionRecordMap()
  const at = new Date().toISOString()
  let persisted = 0

  for (const auction of auctions) {
    throwIfTaskAborted(signal)
    try {
      const record = records.get(cacheKey(auction.platform, auction.externalId))
      if (auction.detailFetchedAt == null && record) mergeStoredAuction(auction, record.auction)
      applyAuctionExtraction(auction, auction.extraction ?? record?.auction.extraction)
      const written = await writeAuctionDetails(auction, auction.extraction ?? null, {
        artifactVersionId: record?.artifactVersionId ?? null,
      })
      if (written?.changed) persisted++
    } catch (err) {
      console.warn(`[geocode] persist ${auction.platform}:${auction.externalId}: ${(err as Error).message}`)
    }
  }

  await upsertCurrentAuctions(auctions, at)
  return persisted
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
