// Fires the refresh task once shortly after server startup so a fresh deploy
// serves from the list cache without waiting for the next cron tick.

export default defineNitroPlugin(() => {
  setTimeout(() => {
    void runTask('refresh').catch((err: unknown) => {
      console.error('[refresh-bootstrap] failed:', (err as Error).message)
    })
  }, 30_000)
})
