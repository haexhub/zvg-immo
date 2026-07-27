// Returns one fully-decorated auction from the enrich-task snapshot. Avoids the
// live crawler so detail-page loads stay fast and the URL stays shareable.
// Staleness is bounded by the enrich task interval (cron `30 */6 * * *`); for
// listings whose snapshot hasn't been built yet (cold cache, recently added)
// the endpoint returns 404 — the user can still reach the source portal via
// the link on the list view.

import type { Auction, LocationEnrichment } from '~/types/auction'
import { applySnapshotPhotosToAuctions, readAuctionSnapshot, type AuctionSnapshot } from '../../../utils/auction-snapshot'
import { applyExtractionToAuctions, readExtractionCache } from '../../../utils/extraction-cache'
import { geocodeAddress } from '../../../utils/geocode'
import { isSafePathSegment } from '../../../utils/path-segment'
import { cacheKey, readVerkehrswertCache } from '../../../utils/verkehrswert-cache'
import { applyDescriptionMarketValue } from '../../../utils/description-market-value'
import { deriveMarketValueEur, getRates } from '../../../utils/exchange-rate'
import { ensureEnabledCountriesLoaded, isCountryEnabled, platforms } from '../../../crawlers/registry'
import { readMergedListCache } from '../../../utils/list-cache'
import { readLocationEnrichment } from '../../../utils/external-data/location-enrichment'

const LIVE_MISS_TTL_MS = 60_000
const liveMissCache = new Map<string, number>()

export interface AuctionDetail extends Auction {
  lat: number | null
  lng: number | null
  locationEnrichment: LocationEnrichment | null
}

function cloneAuction(a: Auction): Auction {
  return {
    ...a,
    attachments: [...a.attachments],
    photoUrls: a.photoUrls ? [...a.photoUrls] : undefined,
    extraction: a.extraction ? { ...a.extraction, features: a.extraction.features ? [...a.extraction.features] : undefined } : undefined,
  }
}

async function findCachedListAuction(platform: string, id: string): Promise<Auction | null> {
  const result = await readMergedListCache()
  const hit = result?.auctions.find((a) => a.platform === platform && a.externalId === id)
  return hit ? cloneAuction(hit) : null
}

function hasFreshLiveMiss(key: string, now = Date.now()): boolean {
  const expiresAt = liveMissCache.get(key)
  if (expiresAt == null) return false
  if (expiresAt > now) return true
  liveMissCache.delete(key)
  return false
}

function rememberLiveMiss(key: string, now = Date.now()): void {
  liveMissCache.set(key, now + LIVE_MISS_TTL_MS)
}

async function findLiveAuction(platform: string, id: string): Promise<Auction | null> {
  const missKey = cacheKey(platform, id)
  if (hasFreshLiveMiss(missKey)) return null
  await ensureEnabledCountriesLoaded()
  const crawler = platforms.find((p) => p.id === platform)
  if (!crawler || !isCountryEnabled(crawler.country)) return null
  const rates = await getRates()
  if (crawler.findOne) {
    try {
      const hit = await crawler.findOne(id)
      if (hit) {
        const auction = cloneAuction(hit)
        deriveMarketValueEur(auction, rates)
        return auction
      }
      rememberLiveMiss(missKey)
      return null
    } catch (err) {
      console.warn(`[api/auction] live item fallback ${platform}/${id}: ${(err as Error).message}`)
    }
  }
  for (const region of crawler.regions) {
    try {
      const result = await crawler.crawl({ region: region.code, immobilienOnly: true, enrichDetails: false })
      const hit = result.auctions.find((a) => a.platform === platform && a.externalId === id)
      if (!hit) continue
      const auction = cloneAuction(hit)
      deriveMarketValueEur(auction, rates)
      return auction
    } catch (err) {
      console.warn(`[api/auction] live fallback ${platform}/${region.code}: ${(err as Error).message}`)
    }
  }
  rememberLiveMiss(missKey)
  return null
}

async function decorateFallbackAuction(auction: Auction, snapshot: AuctionSnapshot): Promise<Auction> {
  const [extractionCache, verkehrswertCache] = await Promise.all([
    readExtractionCache(),
    readVerkehrswertCache(),
  ])
  const key = cacheKey(auction.platform, auction.externalId)
  if (auction.marketValueEur == null) {
    const vw = verkehrswertCache[key]
    if (vw?.marketValueEur != null) {
      auction.marketValueEur = vw.marketValueEur
      auction.marketValueText = vw.marketValueText
    }
  }
  applyDescriptionMarketValue(auction)
  applySnapshotPhotosToAuctions([auction], snapshot)
  applyExtractionToAuctions([auction], extractionCache)
  return auction
}

export default defineEventHandler(async (event): Promise<AuctionDetail> => {
  const platform = String(event.context.params?.platform ?? '')
  const id = String(event.context.params?.id ?? '')
  if (!isSafePathSegment(platform) || !isSafePathSegment(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id' })
  }
  const key = cacheKey(platform, id)
  const snapshot = await readAuctionSnapshot()
  const snapshotHit = snapshot[key]
  const hit =
    (snapshotHit ? cloneAuction(snapshotHit) : null) ??
    (await findCachedListAuction(platform, id)) ??
    (await findLiveAuction(platform, id))
  if (!hit) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }
  const auction = snapshotHit ? hit : await decorateFallbackAuction(hit, snapshot)
  // Cache-only lookup: the geocode task fills coordinates ahead of time, so
  // serving a detail page never blocks on Nominatim.
  const point = await geocodeAddress(auction.address, auction.country, { fetchMissing: false })
  // Source-provided coordinates (crawler-set, preserved in the snapshot) beat
  // the geocoder guess — but only as a complete pair, never mixed with the
  // geocoder's.
  const sourcePoint =
    auction.lat != null && auction.lng != null ? { lat: auction.lat, lng: auction.lng } : null
  const lat = sourcePoint?.lat ?? point?.lat ?? null
  const lng = sourcePoint?.lng ?? point?.lng ?? null
  applyDescriptionMarketValue(auction)
  const locationEnrichment = await readLocationEnrichment(platform, id)
  return { ...auction, lat, lng, locationEnrichment }
})
