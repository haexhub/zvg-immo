// Fires the enrich task once shortly after server startup so a fresh deploy
// fills the extraction cache without waiting for the next cron tick. Deferred
// longer than the geocode bootstrap (which fires at 5s) so the two full crawls
// don't hammer the upstream portals simultaneously on boot.
//
// Guarded like refresh-bootstrap: a restart that lands on an already-warm list
// cache skips the boot run (enrichment fetches detail pages/PDFs from upstream
// portals, so re-running on every restart risks an IP ban). The 6h cron keeps
// it current; a fresh/stale start still runs it.

import { listCacheAgeMs } from '../utils/list-cache'

const MAX_CACHE_AGE_MS = 6 * 60 * 60 * 1000

export default defineNitroPlugin(() => {
  if (process.env.ZVG_SKIP_BOOT_TASKS) return
  setTimeout(() => {
    void (async () => {
      const age = await listCacheAgeMs()
      if (age !== null && age < MAX_CACHE_AGE_MS) {
        console.log(`[enrich-bootstrap] list cache is ${(age / 3_600_000).toFixed(1)}h old — skipping boot enrich`)
        return
      }
      await runTask('enrich')
    })().catch((err: unknown) => {
      console.error('[enrich-bootstrap] failed:', (err as Error).message)
    })
  }, 60_000)
})
