// Resolves addresses of current stored auctions that have no usable position
// yet via the geocoder (Nominatim/LocationIQ) and writes the newly found
// coordinates onto their `auctions` rows. Idempotent: addresses already in the
// geocode cache (hits and known misses) cost no upstream request, so a cold
// run is slow (~40 min for ~2200 lookups at 1 req/s) and later runs finish in
// seconds. Also fills the AT-Edikte/Biddit Verkehrswert cache.
//
// Works from stored data only and never crawls: crawling is refresh's job
// (which honours the per-portal cadence in crawl-cadence.ts) and enrich's,
// which also persists every crawled auction. The trade-off is latency — a
// newly crawled auction gets its stored record (with address) from enrich,
// so geocode picks it up on its first run after that enrich run.
//
// Still gated by the "automatic crawling" switch: the run talks to upstreams
// (the geocoder, and the AT/BE detail pages for the Verkehrswert), which is
// exactly the background traffic that switch exists to stop.
//
// Triggered by the scheduled task config in nuxt.config.ts and once on server
// startup via server/plugins/geocode-bootstrap.ts.

import { runGeocode } from '../utils/tasks/geocode-run'
import { runExclusiveTask } from '../utils/exclusive-task'
import { isAutomaticCrawlingEnabled } from '../utils/automatic-task-gate'

// Guards against overlapping runs: a cold-start bootstrap run can take ~40 min
// and would otherwise race a cron-triggered run of the same task (duplicate
// geocoder traffic, concurrent verkehrswert cache writes).
export default defineTask({
  meta: {
    name: 'geocode',
    description: 'Geocode stored current auctions that have an address but no coordinates (no crawl).',
  },
  async run() {
    if (!await isAutomaticCrawlingEnabled()) {
      console.log('[geocode] automatic crawling disabled — skipping scheduled/boot run')
      return {}
    }
    return await runExclusiveTask('geocode', runGeocode)
  },
})
