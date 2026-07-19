// Fires the enrich task once shortly after server startup so a fresh deploy
// fills the extraction cache without waiting for the next cron tick. Deferred
// longer than the geocode bootstrap (which fires at 5s) so the two full crawls
// don't hammer the upstream portals simultaneously on boot.
//
// Guarded like refresh-bootstrap: a restart that lands on an already-warm list
// cache skips the boot run (enrichment fetches detail pages/PDFs from upstream
// portals, so re-running on every restart risks an IP ban). The 6h cron keeps
// it current; a fresh/stale start still runs it.

import { shouldSkipBootCrawl } from '../utils/boot-crawl-gate'

export default defineNitroPlugin(() => {
  if (process.env.ZVG_SKIP_BOOT_TASKS) return
  setTimeout(() => {
    void (async () => {
      if (await shouldSkipBootCrawl('enrich-bootstrap')) return
      await runTask('enrich')
    })().catch((err: unknown) => {
      console.error('[enrich-bootstrap] failed:', (err as Error).message)
    })
  }, 60_000)
})
