import { geocodeAddress, geocodeStatus } from '~/server/utils/geocode'
import { getPool } from '~/server/utils/db'
import { buildAuctionSearchFilter, finiteNumber } from '~/server/utils/auction-search-filters'

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
  geocodedCount: number
  /** Rows that can never produce a pin: no address, or an address Nominatim
   *  already answered with "not found". `geocodedCount + unresolvableCount <
   *  total` therefore means "some addresses have not been tried yet". */
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
    `SELECT a.platform, a.external_id, a.country, a.region, a.address, a.lat, a.lng
     FROM auctions a
     LEFT JOIN extraction_cache ec
       ON ec.platform = a.platform AND ec.external_id = a.external_id
     ${predicate}
     ORDER BY a.platform, a.external_id
     LIMIT $${values.length + 1}`,
    [...values, MAX_MARKERS],
  )

  const fetchMissing = query.fetch === '1'
  const markers: Array<GeoAuction | undefined> = new Array(rows.length)
  let unresolvableCount = 0
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
      if (lat == null || lng == null) {
        if (!row.address) {
          // Nothing to geocode, ever. Counting it keeps geocodedCount +
          // unresolvableCount able to reach `total`, which is what the client
          // uses to stop its 15s "geocoding läuft" poll.
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
      if (lat == null || lng == null) continue
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
    geocodedCount: auctions.length,
    unresolvableCount,
    fetchedAt: new Date().toISOString(),
  }
})
