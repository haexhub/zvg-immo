// Returns one fully-decorated auction from the enrich-task snapshot. Avoids the
// live crawler so detail-page loads stay fast and the URL stays shareable.
// Staleness is bounded by the enrich task interval (cron `30 */6 * * *`); for
// listings whose snapshot hasn't been built yet (cold cache, recently added)
// the endpoint returns 404 — the user can still reach the source portal via
// the link on the list view.

import type { Auction } from '~/types/auction'
import { readAuctionSnapshot } from '../../../utils/auction-snapshot'
import { geocodeAddress } from '../../../utils/geocode'
import { cacheKey } from '../../../utils/verkehrswert-cache'

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export interface AuctionDetail extends Auction {
  lat: number | null
  lng: number | null
}

export default defineEventHandler(async (event): Promise<AuctionDetail> => {
  const platform = String(event.context.params?.platform ?? '')
  const id = String(event.context.params?.id ?? '')
  if (!SLUG_RE.test(platform) || !SLUG_RE.test(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id' })
  }
  const snapshot = await readAuctionSnapshot()
  const hit = snapshot[cacheKey(platform, id)]
  if (!hit) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }
  // Cache-only lookup: the geocode task fills coordinates ahead of time, so
  // serving a detail page never blocks on Nominatim.
  const point = await geocodeAddress(hit.adresse, hit.country, { fetchMissing: false })
  return { ...hit, lat: point?.lat ?? null, lng: point?.lng ?? null }
})
