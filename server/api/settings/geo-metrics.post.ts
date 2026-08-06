// Manually triggers the WP-4/WP-5 precompute chain from /settings — Nitro's
// own task-run route isn't exposed in production (see reprocess.post.ts),
// and neither build-geo-features nor build-auction-geo-metrics is on a
// scheduledTasks cron short enough to unblock an admin-requested OSM reimport
// (see osm-import.get.ts) the same day. Runs build-geo-features first since
// build-auction-geo-metrics only reads the latest *complete* geo_features
// epoch and otherwise just reports itself skipped.

import type { BuildGeoFeaturesResult } from '~/server/tasks/build-geo-features'
import type { BuildAuctionGeoMetricsResult } from '~/server/tasks/build-auction-geo-metrics'

export interface GeoMetricsRebuildResult {
  geoFeatures: BuildGeoFeaturesResult | { skipped: true }
  auctionGeoMetrics: BuildAuctionGeoMetricsResult | { skipped: true } | { skipped: true; reason: string }
}

export default defineEventHandler(async (event): Promise<GeoMetricsRebuildResult> => {
  const geoFeaturesOutcome = (await runTask('build-geo-features')) as { result: GeoMetricsRebuildResult['geoFeatures'] }
  const auctionGeoMetricsOutcome = (await runTask('build-auction-geo-metrics')) as {
    result: GeoMetricsRebuildResult['auctionGeoMetrics']
  }
  return {
    geoFeatures: geoFeaturesOutcome.result,
    auctionGeoMetrics: auctionGeoMetricsOutcome.result,
  }
})
