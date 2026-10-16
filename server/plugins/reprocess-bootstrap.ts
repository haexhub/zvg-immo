// Fires the reprocess task once shortly after server startup so a fresh
// deploy starts extracting from whatever's already archived without waiting
// for the next cron tick. No boot-crawl-gate here (unlike enrich/refresh/
// geocode): reprocess never touches an upstream portal, only the archive, so
// there's no IP-ban risk in running it on every restart.
//
// Guarded against restart storms: a crash loop (e.g. an OOM crash) restarts
// the container every few minutes, and without this check every restart
// re-fires a full, unbounded reprocess sweep — resubmitting the same backlog
// to the LLM provider over and over instead of once per genuine deploy/start.

import { getTaskRunStatus } from '../utils/task-runs'

// Below the hourly cron cadence so a real deploy after actual downtime still
// gets the "don't wait for the next tick" head start; above the crash-loop
// restart interval observed in practice (minutes, not tens of minutes).
const MIN_INTERVAL_MS = 30 * 60 * 1000

export default defineNitroPlugin(() => {
  if (process.env.ZVG_SKIP_BOOT_TASKS) return
  setTimeout(() => {
    void (async () => {
      const status = await getTaskRunStatus('reprocess')
      if (status.startedAt) {
        const ageMs = Date.now() - new Date(status.startedAt).getTime()
        if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < MIN_INTERVAL_MS) {
          console.log(`[reprocess-bootstrap] reprocess already started ${(ageMs / 60_000).toFixed(1)}min ago — skipping boot run`)
          return
        }
      }
      await runTask('reprocess')
    })().catch((err: unknown) => {
      console.error('[reprocess-bootstrap] failed:', (err as Error).message)
    })
  }, 90_000)
})
