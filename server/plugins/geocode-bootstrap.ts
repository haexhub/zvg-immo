// Fires the geocode task once shortly after server startup so a fresh deploy
// fills the geocode cache without waiting for the next cron tick.
//
// Unlike refresh-/enrich-bootstrap this does not consult the boot crawl gate:
// the geocode task works from stored auctions and never crawls (it used to
// re-crawl every portal, hence the gate). On a warm cache a restart run only
// reads the store and the geocode cache; the task's own automatic-crawling
// switch still applies.

export default defineNitroPlugin(() => {
  if (process.env.ZVG_SKIP_BOOT_TASKS) return
  // Defer so the HTTP listener is up before the long-running task starts.
  setTimeout(() => {
    void runTask('geocode').catch((err: unknown) => {
      console.error('[geocode-bootstrap] failed:', (err as Error).message)
    })
  }, 5000)
})
