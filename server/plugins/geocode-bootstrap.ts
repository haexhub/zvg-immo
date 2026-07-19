// Fires the geocode task once shortly after server startup so a fresh deploy
// fills the disk cache without waiting for the next cron tick.
//
// Guarded like refresh-bootstrap: the geocode task itself crawls every
// registered region (server/tasks/geocode.ts calls crawlAll to collect
// addresses), so re-running it on every restart re-crawls all upstream portals
// and risks an IP ban. Skip when a restart lands on an already-warm cache;
// the cron keeps it current, and Nominatim lookups stay cached regardless.

import { listCacheAgeMs } from '../utils/list-cache'

const MAX_CACHE_AGE_MS = 6 * 60 * 60 * 1000

export default defineNitroPlugin(() => {
  if (process.env.ZVG_SKIP_BOOT_TASKS) return
  // Defer so the HTTP listener is up before the long-running task starts.
  setTimeout(() => {
    void (async () => {
      const age = await listCacheAgeMs()
      if (age !== null && age < MAX_CACHE_AGE_MS) {
        console.log(`[geocode-bootstrap] list cache is ${(age / 3_600_000).toFixed(1)}h old — skipping boot geocode`)
        return
      }
      await runTask('geocode')
    })().catch((err: unknown) => {
      console.error('[geocode-bootstrap] failed:', (err as Error).message)
    })
  }, 5000)
})
