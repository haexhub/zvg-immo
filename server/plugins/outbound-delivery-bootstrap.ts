// Nudge the cheap, DB-only mail worker after a boot so due deliveries do not
// wait for the next cron tick. The worker itself takes row locks, making this
// safe across multiple app processes.
export default defineNitroPlugin(() => {
  if (process.env.ZVG_SKIP_BOOT_TASKS) return
  setTimeout(() => {
    void runTask('outbound-delivery').catch((err: unknown) => {
      console.error('[outbound-delivery-bootstrap] failed:', (err as Error).message)
    })
  }, 15_000)
})
