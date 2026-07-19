import { listCacheAgeMs } from './list-cache'

// The refresh/geocode/enrich boot tasks all crawl every upstream portal
// internally. Skip the boot run when the persisted list cache is younger than
// this, so a restart (crash or podman auto-update) that lands on an
// already-warm cache doesn't re-crawl and risk getting the server IP banned.
// The cron keeps the data current; only a genuinely cold or stale start crawls.
const MAX_CACHE_AGE_MS = 6 * 60 * 60 * 1000

/**
 * True when a boot crawl should be skipped because the list cache is still
 * warm. Logs the reason under the given label (e.g. "refresh-bootstrap").
 */
export async function shouldSkipBootCrawl(label: string): Promise<boolean> {
  const age = await listCacheAgeMs()
  if (age !== null && age < MAX_CACHE_AGE_MS) {
    console.log(`[${label}] list cache is ${(age / 3_600_000).toFixed(1)}h old — skipping boot crawl`)
    return true
  }
  return false
}
