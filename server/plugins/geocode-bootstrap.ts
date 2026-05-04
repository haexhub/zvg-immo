// Fires the geocode task once shortly after server startup so a fresh deploy
// fills the disk cache without waiting for the next cron tick. Subsequent
// restarts re-run it harmlessly (cache hits skip Nominatim).

export default defineNitroPlugin(() => {
  // Defer so the HTTP listener is up before the long-running task starts.
  setTimeout(() => {
    void runTask('geocode').catch((err: unknown) => {
      console.error('[geocode-bootstrap] failed:', (err as Error).message)
    })
  }, 5000)
})
