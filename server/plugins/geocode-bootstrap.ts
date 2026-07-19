// Fires the geocode task once shortly after server startup so a fresh deploy
// fills the disk cache without waiting for the next cron tick.
//
// Guarded like refresh-bootstrap: the geocode task itself crawls every
// registered region (server/tasks/geocode.ts calls crawlAll to collect
// addresses), so re-running it on every restart re-crawls all upstream portals
// and risks an IP ban. Skip when a restart lands on an already-warm cache;
// the cron keeps it current, and Nominatim lookups stay cached regardless.

import { shouldSkipBootCrawl } from '../utils/boot-crawl-gate'

export default defineNitroPlugin(() => {
  if (process.env.ZVG_SKIP_BOOT_TASKS) return
  // Defer so the HTTP listener is up before the long-running task starts.
  setTimeout(() => {
    void (async () => {
      if (await shouldSkipBootCrawl('geocode-bootstrap')) return
      await runTask('geocode')
    })().catch((err: unknown) => {
      console.error('[geocode-bootstrap] failed:', (err as Error).message)
    })
  }, 5000)
})
