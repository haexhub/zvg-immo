import { allScopesFreshWithin } from './crawl-state'
import { getTaskRunStatus, type TrackedTask } from './task-runs'
import { ensureEnabledCountriesLoaded, listRegions } from '../crawlers/registry'

// The refresh/geocode/enrich boot tasks all crawl every upstream portal
// internally. Skip the boot run when every currently enabled scope was
// crawled more recently than this, so a restart (crash or podman
// auto-update) that lands on already-warm data doesn't re-crawl and risk
// getting the server IP banned.
// The cron keeps the data current; only a genuinely cold or stale start crawls.
const MAX_CACHE_AGE_MS = 6 * 60 * 60 * 1000

/**
 * True when a boot crawl should be skipped because every registered
 * (country, region, platform) scope is still warm. A partial prior run — one
 * platform succeeded, a sibling covering the same or another region failed —
 * must not be read as "everything is fresh", or the boot task would skip work
 * a genuinely stale/never-crawled platform still needs. Logs the reason under
 * the given label (e.g. "refresh-bootstrap").
 */
export async function shouldSkipBootCrawl(label: string): Promise<boolean> {
  await ensureEnabledCountriesLoaded()
  const scopes = listRegions().flatMap((r) =>
    r.platforms.map((p) => ({ country: r.country, region: r.code, platform: p.id })),
  )
  const fresh = await allScopesFreshWithin(scopes, MAX_CACHE_AGE_MS)
  if (fresh) {
    console.log(`[${label}] every registered scope crawled within ${(MAX_CACHE_AGE_MS / 3_600_000).toFixed(1)}h — skipping boot crawl`)
  }
  return fresh
}

/**
 * True when `task` started a run less than `maxAgeMs` ago — the restart-storm
 * guard for boot runs, keyed on the persisted task-run status instead of crawl
 * freshness. `startedAt` survives an interrupted run (resetInterruptedTaskRuns
 * keeps it), so a crash loop cannot re-fire the run on every restart either.
 * Logs the reason under the given label.
 */
export async function taskStartedWithin(task: TrackedTask, maxAgeMs: number, label: string): Promise<boolean> {
  const { startedAt } = await getTaskRunStatus(task)
  if (!startedAt) return false
  const ageMs = Date.now() - new Date(startedAt).getTime()
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= maxAgeMs) return false
  console.log(`[${label}] ${task} already started ${(ageMs / 60_000).toFixed(1)}min ago — skipping boot run`)
  return true
}
