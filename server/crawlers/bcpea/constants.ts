import type { RegionInfo } from '../types'

export const PLATFORM_ID = 'bg-bcpea'
export const COUNTRY = 'bg'
export const BASE_URL = 'https://sales.bcpea.org'
export const LIST_PATH = '/properties'

export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/** sales.bcpea.org's robots.txt (verified live) carries no Crawl-delay
 *  directive, only a path Disallow — this is a polite default for what reads
 *  as a small chamber-run PHP site, the same value kip.net's own explicit
 *  "Crawl-delay: 1" resolves to. Enforced for every request — list
 *  pagination and detail enrichment alike — by the shared queue in fetch.ts,
 *  since the enrich task calls enrichOne with concurrency across several
 *  auctions at once. */
export const CRAWL_DELAY_MS = 1_000

/** The Chamber of Private Enforcement Agents' portal exposes 28 district-court
 *  filters (`?court=<id>`), but a single nationwide page loop already covers
 *  every listing (verified live: ~1173 properties over 12 pages at
 *  perpage=100) — same "no sub-region split" convention as bg-zapori, which
 *  keeps the BG region dropdown free of a second, court-based taxonomy that
 *  nothing else in the project uses. */
export const BCPEA_REGIONS: readonly RegionInfo[] = [{ code: 'all', name: 'Bulgarien' }] as const

/** Comfortably above the current ~12-page total (perpage=100) even as the
 *  catalog grows; fetchAllListings (list.ts) stops as soon as a page comes
 *  back with zero items rather than relying on this cap in the normal case. */
export const MAX_PAGES = 60
export const PAGE_SIZE = 100

/** Title-text keywords marking a lot's `category` (кв.м) figure as land
 *  rather than living area — the site exposes no separate structured
 *  property-type id on the list/detail cards, only this free-text title, so
 *  land is recognised by substring instead of an enum (same "text says X"
 *  fallback bg/text.ts already uses for addresses). Covers Земеделска земя /
 *  Земеделски имот (agricultural land/property) and Парцел[ с къща] / Къща с
 *  парцел (plot, incl. combined plot+house lots, where the published area is
 *  the land size, not the house's floor area). */
export const LAND_TITLE_KEYWORDS = ['земя', 'парцел', 'земеделск'] as const

/** A small number of listings on this otherwise real-estate-only portal are
 *  vehicles ("МПС") or generic bulk-asset lots — verified live (1 of 1173
 *  sampled) — excluded the same way every other crawler in this project
 *  drops non-property lots. */
export const NON_PROPERTY_TITLES = ['мпс', 'имущество'] as const

/** "Едностаен/Двустаен/..." room-count adjectives prefixing apartment titles
 *  ("Двустаен апартамент" = two-room apartment) — the only place a room count
 *  is available, since the detail page has no separate structured field. */
export const ROOM_COUNT_BY_PREFIX: Record<string, number> = {
  едностаен: 1,
  двустаен: 2,
  тристаен: 3,
  четиристаен: 4,
}
