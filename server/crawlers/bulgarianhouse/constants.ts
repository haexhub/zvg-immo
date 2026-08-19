import type { RegionInfo } from '../types'

export const BASE_URL = 'https://www.bulgarianhouse.com'
export const PLATFORM_ID = 'bg-bulgarianhouse'
export const COUNTRY = 'bg'
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** A single foreign-buyer real-estate agency, not a court/government
 *  registry — no case number to publish (same precedent as kip/constants.ts
 *  and dga-ag/constants.ts) and, unlike kip.net, no per-listing "Anbieter" to
 *  extract since every object is sold by this one agency. */
export const FALLBACK_AUTHORITY = 'Bulgarian House Ltd'

/** robots.txt (verified live) carries only a Sitemap: line, no Crawl-delay —
 *  this is a polite default for what reads as a small, independently-run PHP
 *  site, the same value kip.net's own explicit "Crawl-delay: 1" resolves to.
 *  Enforced for every request — list pagination and detail enrichment alike —
 *  by the shared queue in fetch.ts. */
export const CRAWL_DELAY_MS = 1_000

/** Nationwide only: the combined `/properties/<n>.page?sort=date_desc` feed
 *  already spans every Bulgarian oblast in one paginated, newest-first
 *  sequence (verified live — cards from Haskovo, Lovech, Pleven, Razgrad,
 *  Stara Zagora, Vidin, ... all appear together on one page). Matches
 *  bg-zapori/bg-bcpea's convention of a single 'all' crawl-scope region
 *  instead of introducing a ~28-oblast taxonomy no other BG platform needs.
 *  The actual oblast per listing is still captured per-item in
 *  Auction.region/address from the card/detail markup (see list.ts/detail.ts)
 *  — it just doesn't partition the crawl itself. */
export const BG_REGIONS: readonly RegionInfo[] = [{ code: 'all', name: 'Bulgarien' }] as const
