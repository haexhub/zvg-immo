// Returns the same list as /api/auctions but with each auction enriched with
// lat/lng coordinates obtained from OpenStreetMap Nominatim. Geocoding is
// disk-cached so repeat calls are fast; the first cold run can take a couple
// of minutes due to Nominatim's 1 req/s rate limit.

import { crawlAll, crawlSingle } from '../crawlers/registry'
import { geocodeAddress } from '../utils/geocode'
import type { Auction, CrawlResult } from '~/types/auction'

export interface GeoAuction extends Auction {
  lat: number | null
  lng: number | null
}

export interface GeoCrawlResult extends Omit<CrawlResult, 'auctions'> {
  auctions: GeoAuction[]
  geocodedCount: number
}

export default defineEventHandler(async (event): Promise<GeoCrawlResult> => {
  const query = getQuery(event)
  const land = (typeof query.land === 'string' ? query.land : 'sn').toLowerCase()
  const immobilienOnly = query.immo !== '0'
  // ?fetch=0 → use only cached geocodes (instant). ?fetch=1 (default) → fall back to Nominatim
  // for missing addresses (subject to 1 req/s rate limit, slow on cold start).
  const fetchMissing = query.fetch !== '0'

  const result: CrawlResult =
    land === 'all'
      ? await crawlAll({ immobilienOnly })
      : await crawlSingle({ bundesland: land, immobilienOnly })

  const enriched: GeoAuction[] = []
  for (const a of result.auctions) {
    const point = await geocodeAddress(a.adresse, { fetchMissing })
    enriched.push({ ...a, lat: point?.lat ?? null, lng: point?.lng ?? null })
  }

  return {
    ...result,
    auctions: enriched,
    geocodedCount: enriched.filter((a) => a.lat != null).length,
  }
})
