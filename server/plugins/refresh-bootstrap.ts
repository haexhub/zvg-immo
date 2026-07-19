// Fires the refresh task once shortly after server startup so a fresh deploy
// serves from the list cache without waiting for the next cron tick.
//
// Guarded so a restart (crash or podman auto-update) that lands on an
// already-warm cache does NOT re-crawl every upstream portal — repeated cold
// crawls otherwise risk getting the server IP banned. The 12h cron
// (nuxt.config.ts) keeps the cache current; this bootstrap only covers a
// genuinely cold or stale start.

import { shouldSkipBootCrawl } from '../utils/boot-crawl-gate'

export default defineNitroPlugin(() => {
  if (process.env.ZVG_SKIP_BOOT_TASKS) return
  setTimeout(() => {
    void (async () => {
      if (await shouldSkipBootCrawl('refresh-bootstrap')) return
      await runTask('refresh')
    })().catch((err: unknown) => {
      console.error('[refresh-bootstrap] failed:', (err as Error).message)
    })
  }, 30_000)
})
