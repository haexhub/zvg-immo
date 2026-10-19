// Fires the enrich task once shortly after server startup so a fresh deploy
// fills the extraction cache without waiting for the next cron tick. Deferred
// longer than the geocode bootstrap (which fires at 5s) so geocode's
// AT-Edikte/Biddit detail fetches and this crawl don't start together on boot.
//
// Guarded on the last enrich run first: the scope-freshness gate alone almost
// never closes, because the hourly refresh keeps 6h-cadence portals at 6-7h
// and bg-alo at up to 24h (crawl-cadence.ts) — so nearly every restart
// re-fired a full ~40-minute crawl/detail run against the upstream portals
// (enrichment fetches detail pages/PDFs, re-running it on every restart risks
// an IP ban). The 6h cron keeps it current; a cold/stale start still runs it.

import { shouldSkipBootCrawl, taskStartedWithin } from '../utils/boot-crawl-gate'

// The enrich cron cadence ('30 */6 * * *' in nuxt.config.ts): a run started
// within it means the next regular tick comes sooner than a boot run would add
// anything — including a run a restart interrupted.
const ENRICH_CRON_INTERVAL_MS = 6 * 60 * 60 * 1000

export default defineNitroPlugin(() => {
  if (process.env.ZVG_SKIP_BOOT_TASKS) return
  setTimeout(() => {
    void (async () => {
      if (await taskStartedWithin('enrich', ENRICH_CRON_INTERVAL_MS, 'enrich-bootstrap')) return
      if (await shouldSkipBootCrawl('enrich-bootstrap')) return
      await runTask('enrich')
    })().catch((err: unknown) => {
      console.error('[enrich-bootstrap] failed:', (err as Error).message)
    })
  }, 60_000)
})
