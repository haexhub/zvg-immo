// Fires the reprocess task once shortly after server startup so a fresh
// deploy starts extracting from whatever's already archived without waiting
// for the next cron tick. No boot-crawl-gate here (unlike enrich/refresh/
// geocode): reprocess never touches an upstream portal, only the archive, so
// there's no IP-ban risk in running it on every restart.

export default defineNitroPlugin(() => {
  if (process.env.ZVG_SKIP_BOOT_TASKS) return
  setTimeout(() => {
    void runTask('reprocess').catch((err: unknown) => {
      console.error('[reprocess-bootstrap] failed:', (err as Error).message)
    })
  }, 90_000)
})
