// Per-portal background-refresh cadence. The refresh task runs hourly (see the
// scheduledTasks config in nuxt.config.ts) and re-crawls each region only when
// its persisted list cache is older than the region's interval below — so
// robust portals stay fresh hourly while rate-limited / block-prone ones are
// polled gently. This is the single place to tune how often a portal is hit.

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000 // hourly

// Portals that captcha, rate-limit (HTTP 429) or block aggressive polling get
// a longer cadence. Keyed by platform id (see server/crawlers/registry.ts
// `platforms`). Add an entry here to slow a portal down.
const SENSITIVE_INTERVAL_MS: Record<string, number> = {
  boe: 6 * 60 * 60 * 1000, // ES: BOE captcha cooldowns
  agi: 6 * 60 * 60 * 1000, // IT: agi returns HTTP 429 under frequent polling
  'fr-licitor': 6 * 60 * 60 * 1000, // FR: robots.txt blocks non-browser crawlers
  // BG: ~1,140 list pages per full walk at kip's 1s crawl delay (~20 min of
  // continuous requests) — an hourly re-crawl would keep the site under
  // near-permanent load from us, and classifieds turnover does not need it.
  // Note the knock-on effect of the "longest interval wins" rule below: bg-alo
  // and bg/zapori both register the ALL scope, so they share one region entry
  // and zapori's court auctions are re-crawled daily too, not hourly. Accepted
  // because judicial sale dates are published weeks ahead; undoing it would
  // take a per-platform (rather than per-region) freshness check in refresh.ts.
  'bg-alo': 24 * 60 * 60 * 1000,
}

/**
 * Min age the region's list cache must reach before the background refresh
 * re-crawls it. A region served by several portals uses the most conservative
 * (longest) interval, so a sensitive portal is never over-polled just because
 * a robust portal shares its region.
 */
export function regionRefreshIntervalMs(platformIds: readonly string[]): number {
  let interval = DEFAULT_INTERVAL_MS
  for (const id of platformIds) {
    const sensitive = SENSITIVE_INTERVAL_MS[id]
    if (sensitive && sensitive > interval) interval = sensitive
  }
  return interval
}
