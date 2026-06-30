// Fires the enrich task once shortly after server startup so a fresh deploy
// fills the extraction cache without waiting for the next cron tick. Deferred
// longer than the geocode bootstrap (which fires at 5s) so the two full crawls
// don't hammer the upstream portals simultaneously on boot. Subsequent restarts
// re-run it harmlessly (cached ids are skipped).

export default defineNitroPlugin(() => {
  setTimeout(() => {
    void runTask('enrich').catch((err: unknown) => {
      console.error('[enrich-bootstrap] failed:', (err as Error).message)
    })
  }, 60_000)
})
