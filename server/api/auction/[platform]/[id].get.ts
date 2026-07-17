// Returns one fully-decorated auction from the enrich-task snapshot. Avoids the
// live crawler so detail-page loads stay fast and the URL stays shareable.
// Staleness is bounded by the enrich task interval (cron `30 */6 * * *`); for
// listings whose snapshot hasn't been built yet (cold cache, recently added)
// the endpoint returns 404 — the user can still reach the source portal via
// the link on the list view.

import type { Auction } from '~/types/auction'
import { readAuctionSnapshot } from '../../../utils/auction-snapshot'
import { geocodeAddress } from '../../../utils/geocode'
import { isSafePathSegment } from '../../../utils/path-segment'
import { cacheKey } from '../../../utils/verkehrswert-cache'
import { readSummaryCache } from '../../../utils/summary-cache'

export interface AuctionDetail extends Auction {
  lat: number | null
  lng: number | null
  /** Pre-generated German AI summary, or null when not yet requested. */
  summary: string | null
}

export default defineEventHandler(async (event): Promise<AuctionDetail> => {
  const platform = String(event.context.params?.platform ?? '')
  const id = String(event.context.params?.id ?? '')
  if (!isSafePathSegment(platform) || !isSafePathSegment(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id' })
  }
  const key = cacheKey(platform, id)
  const snapshot = await readAuctionSnapshot()
  const hit = snapshot[key]
  if (!hit) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }
  // Cache-only lookup: the geocode task fills coordinates ahead of time, so
  // serving a detail page never blocks on Nominatim.
  const [point, summaryCache] = await Promise.all([
    geocodeAddress(hit.adresse, hit.country, { fetchMissing: false }),
    readSummaryCache(),
  ])
  const summary = summaryCache[key]?.text ?? null
  // Source-provided coordinates (crawler-set, preserved in the snapshot) beat
  // the geocoder guess — but only as a complete pair, never mixed with the
  // geocoder's.
  const sourcePoint =
    hit.lat != null && hit.lng != null ? { lat: hit.lat, lng: hit.lng } : null
  const lat = sourcePoint?.lat ?? point?.lat ?? null
  const lng = sourcePoint?.lng ?? point?.lng ?? null
  return { ...hit, lat, lng, summary }
})
