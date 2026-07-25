// Manually triggers server/tasks/refresh.ts (crawl every region due for a
// refresh, per crawl-cadence.ts) from /settings — admin-only via the
// settings-auth guard. Nitro's own task-run route isn't exposed in
// production, and there was previously no way to force a refresh tick
// on demand (e.g. verifying a raw-archive fix against live auctions)
// without waiting for the hourly cron.

export default defineEventHandler(async () => {
  return await runTask('refresh')
})
