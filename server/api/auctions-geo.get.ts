import { geocodeAddress, geocodeStatus } from '~/server/utils/geocode'
import { getPool } from '~/server/utils/db'
import { buildAuctionSearchFilter, finiteNumber } from '~/server/utils/auction-search-filters'
import { LATEST_DETAILS_JOIN_SQL } from '~/server/api/auctions.get'
import { countryCentroid } from '~/lib/country-bounds'

// A map beyond this many pins is not readable anyway, and every row here can
// cost a geocode lookup — so cap the marker set instead of streaming the whole
// auctions table through the geocoder on an unfiltered search.
const MAX_MARKERS = 5000

export interface GeoAuction {
  platform: string
  externalId: string
  country: string
  region: string
  lat: number
  lng: number
}

export interface GeoCrawlResult {
  auctions: GeoAuction[]
  /** Rows this response accounted for — the match set capped at MAX_MARKERS,
   *  not the total number of search hits (that comes from /api/auctions). */
  total: number
  /** Rows placed at a real, address-derived position — excludes rows that
   *  only got a country-centroid fallback pin (see `unresolvableCount`). */
  geocodedCount: number
  /** Rows that can never get an exact pin: no address, or an address
   *  Nominatim already answered with "not found". These still render a
   *  marker (at their country's centroid, see countryCentroid), just not a
   *  precise one. `geocodedCount + unresolvableCount < total` therefore means
   *  "some addresses have not been tried yet". */
  unresolvableCount: number
  fetchedAt: string
}

interface MarkerRow {
  platform: string
  external_id: string
  country: string
  region: string
  address: string | null
  lat: string | number | null
  lng: string | number | null
}

export default defineEventHandler(async (event): Promise<GeoCrawlResult> => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Auktionsdatenbank ist nicht konfiguriert' })
  }

  const query = getQuery(event)
  const { predicate, values } = await buildAuctionSearchFilter(db, query)

  const { rows } = await db.query<MarkerRow>(
    `SELECT a.platform, a.external_id, a.country, a.region, d.address, d.lat, d.lng
     FROM auctions a
     ${LATEST_DETAILS_JOIN_SQL}
     ${predicate}
     ORDER BY a.platform, a.external_id
     LIMIT $${values.length + 1}`,
    [...values, MAX_MARKERS],
  )

  const fetchMissing = query.fetch === '1'
  const markers: Array<GeoAuction | undefined> = new Array(rows.length)
  let unresolvableCount = 0
  // Distinct from auctions.length: rows placed at their country's centroid
  // (no real position) still render a marker but must not count as geocoded,
  // or the client's "geocoding läuft" poll (geocodedCount + unresolvableCount
  // vs. total) would stop before addresses still pending a lookup are tried.
  let preciseCount = 0
  let cursor = 0
  let aborted = false
  event.node.req.on('close', () => {
    aborted = true
  })

  async function worker(): Promise<void> {
    while (cursor < rows.length && !aborted) {
      const index = cursor++
      const row = rows[index]!
      let lat = finiteNumber(row.lat)
      let lng = finiteNumber(row.lng)
      // Null Island is never a genuine position for any crawled country —
      // treat a stored (0,0) the same as "not yet geocoded" instead of
      // trusting it as an exact pin.
      if (lat === 0 && lng === 0) {
        lat = null
        lng = null
      }
      if (lat == null || lng == null) {
        if (!row.address) {
          unresolvableCount++
        } else {
          const point = await geocodeAddress(row.address, row.country, { fetchMissing })
          lat = point?.lat ?? null
          lng = point?.lng ?? null
          if (!point && await geocodeStatus(row.address, row.country) === 'unresolvable') {
            unresolvableCount++
          }
        }
      }
      if (lat != null && lng != null) {
        preciseCount++
      } else {
        // No address, or Nominatim/LocationIQ can't resolve it — place the
        // marker at the country's centroid instead of dropping it, so it at
        // least lands in the right country rather than vanishing or (worse)
        // sitting at 0,0 in the Gulf of Guinea.
        const fallback = countryCentroid(row.country)
        if (!fallback) continue
        lat = fallback.lat
        lng = fallback.lng
      }
      markers[index] = {
        platform: row.platform,
        externalId: row.external_id,
        country: row.country,
        region: row.region,
        lat,
        lng,
      }
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker))
  const auctions = markers.filter((marker): marker is GeoAuction => marker != null)
  setResponseHeader(event, 'cache-control', 'no-store')
  return {
    auctions,
    total: rows.length,
    geocodedCount: preciseCount,
    unresolvableCount,
    fetchedAt: new Date().toISOString(),
  }
})
