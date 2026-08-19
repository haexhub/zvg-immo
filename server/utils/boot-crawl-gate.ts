import { crawlStateAgeMs } from './crawl-state'

// The refresh/geocode/enrich boot tasks all crawl every upstream portal
// internally. Skip the boot run when the last successful crawl is younger than
// this, so a restart (crash or podman auto-update) that lands on already-warm
// data doesn't re-crawl and risk getting the server IP banned.
// The cron keeps the data current; only a genuinely cold or stale start crawls.
const MAX_CACHE_AGE_MS = 6 * 60 * 60 * 1000

/**
 * True when a boot crawl should be skipped because the crawled data is still
 * warm. Logs the reason under the given label (e.g. "refresh-bootstrap").
 */
export async function shouldSkipBootCrawl(label: string): Promise<boolean> {
  const age = await crawlStateAgeMs()
  if (age !== null && age < MAX_CACHE_AGE_MS) {
    console.log(`[${label}] last crawl was ${(age / 3_600_000).toFixed(1)}h ago — skipping boot crawl`)
    return true
  }
  return false
}
