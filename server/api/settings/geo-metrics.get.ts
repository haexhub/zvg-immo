// Feeds SettingsGeoMetricsCard.vue: how far the WP-4/WP-5 precompute chain
// (build-geo-features.ts -> build-auction-geo-metrics.ts) has progressed,
// since neither task has a production trigger of its own (see geo-
// metrics.post.ts).

export interface GeoMetricsStatus {
  geoFeaturesRows: number
  latestEpoch: number | null
  latestEpochCompletedAt: string | null
  auctionGeoMetricsRows: number
}

export default defineEventHandler(async (event): Promise<GeoMetricsStatus> => {
  const db = getPool()
  if (!db) {
    return { geoFeaturesRows: 0, latestEpoch: null, latestEpochCompletedAt: null, auctionGeoMetricsRows: 0 }
  }

  const [{ rows: featureRows }, { rows: epochRows }, { rows: metricRows }] = await Promise.all([
    db.query<{ count: string }>('SELECT count(*) FROM geo_features'),
    db.query<{ epoch: number; completed_at: string }>(
      'SELECT epoch, completed_at FROM geo_features_epochs ORDER BY epoch DESC LIMIT 1',
    ),
    db.query<{ count: string }>('SELECT count(*) FROM auction_geo_metrics'),
  ])

  return {
    geoFeaturesRows: Number(featureRows[0]?.count ?? 0),
    latestEpoch: epochRows[0]?.epoch ?? null,
    latestEpochCompletedAt: epochRows[0]?.completed_at ?? null,
    auctionGeoMetricsRows: Number(metricRows[0]?.count ?? 0),
  }
})
