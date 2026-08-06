// Manually triggers the WP-4/WP-5 precompute chain from /settings — Nitro's
// own task-run route isn't exposed in production (see reprocess.post.ts),
// and neither build-geo-features nor build-auction-geo-metrics is on a
// scheduledTasks cron short enough to unblock an admin-requested OSM reimport
// (see osm-import.get.ts) the same day.
//
// Detached, not awaited: build-geo-features scans the full osm_local_elements
// table (tens of millions of rows across all countries) and can run far
// longer than the reverse proxy keeps a request open — same rationale as
// countries/[country]/enrich.post.ts detaching reprocess/external-enrichment.
// Awaiting it here would also be actively dangerous: runExclusiveTask aborts
// a task's in-flight run as soon as a new invocation starts, so a client
// retrying after a perceived timeout would abort an almost-finished rebuild
// and restart it, potentially forever. Chained via .then so
// build-auction-geo-metrics only starts once build-geo-features has
// published a complete epoch; poll GET /api/settings/geo-metrics for
// progress instead of waiting on this response.

export interface GeoMetricsRebuildResult {
  started: true
}

export default defineEventHandler(async (event): Promise<GeoMetricsRebuildResult> => {
  void runTask('build-geo-features')
    .then(() => runTask('build-auction-geo-metrics'))
    .catch((err: unknown) => {
      console.error('[settings/geo-metrics] rebuild chain failed:', (err as Error).message)
    })
  return { started: true }
})
