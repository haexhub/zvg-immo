// Small dedicated reader for the auction_geo_metrics row consumed by GIS
// WP-8 (leisure-tourism-profile.ts). Deliberately not folded into
// auction-record.ts: that reader is used broadly (admin lists, batch reads)
// where this extra join would be dead weight on every row; only the
// detail-page route (server/api/auction/[platform]/[id].get.ts) needs it,
// same reasoning as location-enrichment.ts's own dedicated per-auction read.
import { getPool } from './db'
import type { LeisureTourismMetricsInput } from './leisure-tourism-profile'

interface GeoMetricsRow {
  dist_ski_m: number | null
  dist_sea_m: number | null
  dist_lake_m: number | null
  dist_hiking_m: number | null
  tourism_density_count: number | null
  attraction_density_count: number | null
}

export async function readAuctionGeoMetrics(platform: string, externalId: string): Promise<LeisureTourismMetricsInput | null> {
  const db = getPool()
  if (!db) return null
  const { rows } = await db.query<GeoMetricsRow>(
    `SELECT dist_ski_m, dist_sea_m, dist_lake_m, dist_hiking_m, tourism_density_count, attraction_density_count
     FROM auction_geo_metrics WHERE platform = $1 AND external_id = $2`,
    [platform, externalId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    distSkiM: row.dist_ski_m,
    distSeaM: row.dist_sea_m,
    distLakeM: row.dist_lake_m,
    distHikingM: row.dist_hiking_m,
    tourismDensityCount: row.tourism_density_count,
    attractionDensityCount: row.attraction_density_count,
  }
}
