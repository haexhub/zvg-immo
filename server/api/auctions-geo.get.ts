// Returns the same list as /api/auctions but with each auction enriched with
// lat/lng coordinates obtained from OpenStreetMap Nominatim. Geocoding is
// disk-cached so repeat calls are fast; the first cold run can take a couple
// of minutes due to Nominatim's 1 req/s rate limit.

import { geocodeAddress, geocodeStatus } from '../utils/geocode'
import { readAuctionSnapshot } from '../utils/auction-snapshot'
import { cacheKey } from '../utils/verkehrswert-cache'
import type { Auction, CrawlResult } from '~/types/auction'

export interface GeoAuction extends Auction {
  lat: number | null
  lng: number | null
  /** Whether /api/auction/[platform]/[id] can serve this auction yet — false
   *  for listings crawled since the last enrich run, before they land in the
   *  snapshot the detail page reads from. */
  detailAvailable: boolean
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
  const [result, snapshot] = await Promise.all([
    $fetch<CrawlResult>('/api/auctions', {
      query: { country, region, immo: immobilienOnly ? '1' : '0' },
    }),
    readAuctionSnapshot(),
  ])

  // Cache reads dominate this loop (thousands of auctions on the "all
  // countries" view), so resolve them concurrently instead of one at a time.
  // Actual Nominatim/LocationIQ requests stay safely throttled regardless of
  // concurrency here — geocodeOnce serialises them through a shared queue.
  const enriched: GeoAuction[] = new Array(result.auctions.length)
  let unresolvableCount = 0
  const CONCURRENCY = 16
  let cursor = 0

  // A client that gives up (tab closed, request aborted, load-balancer
  // timeout) still leaves this loop running server-side — with fetch=1 and a
  // large cold backlog it can otherwise keep churning through the shared
  // geocode rate limiter for minutes after nobody's listening. Stop
  // dispatching new lookups once the connection drops; whatever's already
  // in flight still finishes and gets cached.
  let aborted = false
  event.node.req.on('close', () => {
    aborted = true
  })

  async function worker(): Promise<void> {
    while (cursor < result.auctions.length) {
      if (aborted) return
      const idx = cursor++
      const a = result.auctions[idx]!
      const snapshotHit = snapshot[cacheKey(a.platform, a.zvgId)]
      const detailAvailable = snapshotHit != null
      // Source-provided coordinates beat a geocoder guess — and cost nothing.
      // List-crawl coords sit on the auction itself; enrichOne-provided ones
      // only exist in the snapshot (the /api/auctions list cache is built
      // without detail fetches).
      const srcLat = a.lat ?? snapshotHit?.lat
      const srcLng = a.lng ?? snapshotHit?.lng
      if (srcLat != null && srcLng != null) {
        enriched[idx] = { ...a, lat: srcLat, lng: srcLng, detailAvailable }
        continue
      }
      const point = await geocodeAddress(a.adresse, a.country, { fetchMissing })
      enriched[idx] = { ...a, lat: point?.lat ?? null, lng: point?.lng ?? null, detailAvailable }
      if (point == null) {
        const status = await geocodeStatus(a.adresse, a.country)
        if (status === 'unresolvable') unresolvableCount++
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  return {
    ...result,
    auctions: enriched,
    geocodedCount: enriched.filter((a) => a.lat != null).length,
    unresolvableCount,
  }
})
