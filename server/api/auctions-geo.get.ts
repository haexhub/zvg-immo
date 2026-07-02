// Returns the same list as /api/auctions but with each auction enriched with
// lat/lng coordinates obtained from OpenStreetMap Nominatim. Geocoding is
// disk-cached so repeat calls are fast; the first cold run can take a couple
// of minutes due to Nominatim's 1 req/s rate limit.

import { geocodeAddress, geocodeStatus } from '../utils/geocode'
import type { Auction, CrawlResult } from '~/types/auction'

export interface GeoAuction extends Auction {
  lat: number | null
  lng: number | null
}

export interface GeoCrawlResult extends Omit<CrawlResult, 'auctions'> {
  auctions: GeoAuction[]
  geocodedCount: number
  /** Addresses tried against Nominatim without a hit (cached as notFound).
   *  Once this + geocodedCount equals auctions.length there is nothing left
   *  to attempt — the client stops showing "läuft …". */
  unresolvableCount: number
}

export default defineEventHandler(async (event): Promise<GeoCrawlResult> => {
  const query = getQuery(event)
  const country = typeof query.country === 'string' ? query.country.toLowerCase() : 'all'
  const region = typeof query.region === 'string' ? query.region.toLowerCase() : 'all'
  const immobilienOnly = query.immo !== '0'
  // ?fetch=0 → use only cached geocodes (instant). ?fetch=1 (default) → fall back to Nominatim
  // for missing addresses (subject to 1 req/s rate limit, slow on cold start).
  const fetchMissing = query.fetch !== '0'

  // Reuse the /api/auctions handler instead of calling crawlAll directly.
  // That route is SWR-cached (see nuxt.config.ts), so a hot cache returns in
  // a few ms. Calling crawlAll here would re-run the full multi-state crawl
  // on every request and time out behind Traefik in production.
  const result = await $fetch<CrawlResult>('/api/auctions', {
    query: { country, region, immo: immobilienOnly ? '1' : '0' },
  })

  const enriched: GeoAuction[] = []
  let unresolvableCount = 0
  for (const a of result.auctions) {
    const point = await geocodeAddress(a.adresse, a.country, { fetchMissing })
    enriched.push({ ...a, lat: point?.lat ?? null, lng: point?.lng ?? null })
    if (point == null) {
      const status = await geocodeStatus(a.adresse, a.country)
      if (status === 'unresolvable') unresolvableCount++
    }
  }

  return {
    ...result,
    auctions: enriched,
    geocodedCount: enriched.filter((a) => a.lat != null).length,
    unresolvableCount,
  }
})
