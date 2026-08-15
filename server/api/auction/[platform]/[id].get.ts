// Returns the structured current aggregate. A short live/list fallback remains
// for a just-discovered auction whose first database write has not landed yet.

import type { Auction, LocationEnrichment } from '~/types/auction'
import { geocodeAddress } from '../../../utils/geocode'
import { isSafePathSegment } from '../../../utils/path-segment'
import { cacheKey } from '../../../utils/verkehrswert-cache'
import { applyDescriptionMarketValue } from '../../../utils/description-market-value'
import { deriveMarketValueEur, getRates } from '../../../utils/exchange-rate'
import { ensureEnabledCountriesLoaded, isCountryEnabled, platforms } from '../../../crawlers/registry'
import { readMergedListCache } from '../../../utils/list-cache'
import { readLocationEnrichment } from '../../../utils/external-data/location-enrichment'
import { readAuctionRecord } from '../../../utils/auction-record'
import { readAuctionRelationships, type RelatedAuction } from '../../../utils/auction-relationships'

const LIVE_MISS_TTL_MS = 60_000
const liveMissCache = new Map<string, number>()

export interface AuctionDetail extends Auction {
  lat: number | null
  lng: number | null
  locationEnrichment: LocationEnrichment | null
  relatedAuctions: RelatedAuction[]
}

function cloneAuction(a: Auction): Auction {
  return {
    ...a,
    attachments: [...a.attachments],
    photoUrls: a.photoUrls ? [...a.photoUrls] : undefined,
    extraction: a.extraction ? { ...a.extraction, features: a.extraction.features ? [...a.extraction.features] : undefined } : undefined,
  }
}

async function findCachedListAuction(platform: string, id: string, country?: string): Promise<Auction | null> {
  const result = await readMergedListCache(country)
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

export default defineEventHandler(async (event): Promise<AuctionDetail> => {
  const platform = String(event.context.params?.platform ?? '')
  const id = String(event.context.params?.id ?? '')
  if (!isSafePathSegment(platform) || !isSafePathSegment(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id' })
  }
  const stored = await readAuctionRecord(platform, id)
  const hit =
    stored?.auction ??
    (await findCachedListAuction(platform, id)) ??
    (await findLiveAuction(platform, id))
  if (!hit) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }
  const auction = cloneAuction(hit)
  // Cache-only lookup: the geocode task fills coordinates ahead of time, so
  // serving a detail page never blocks on Nominatim.
  const point = await geocodeAddress(auction.address, auction.country, { fetchMissing: false })
  // Source-provided coordinates (crawler-set, preserved in auction_details) beat
  // the geocoder guess — but only as a complete pair, never mixed with the
  // geocoder's.
  const sourcePoint =
    auction.lat != null && auction.lng != null ? { lat: auction.lat, lng: auction.lng } : null
  const lat = sourcePoint?.lat ?? point?.lat ?? null
  const lng = sourcePoint?.lng ?? point?.lng ?? null
  applyDescriptionMarketValue(auction)
  deriveMarketValueEur(auction, await getRates())
  const [locationEnrichment, relatedAuctions] = await Promise.all([
    readLocationEnrichment(platform, id),
    readAuctionRelationships(platform, id),
  ])
  return { ...auction, lat, lng, locationEnrichment, relatedAuctions }
})
