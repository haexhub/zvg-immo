import type { RegionInfo } from '../types'

export const GB_BASE = 'https://www.auctionhouse.co.uk'
export const GB_ONLINE_BASE = 'https://online.auctionhouse.co.uk'
export const COUNTRY = 'gb'
export const PLATFORM_ID = 'gb-auctionhouse'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/** Auction House UK has no user-facing sub-region filter of its own (the
 *  franchise's ~30 regional branch sites below are purely an internal
 *  listing split — see GB_LIST_REGIONS) — same "collapse to one region"
 *  precedent as Licitor (fr/constants.ts). */
export const GB_REGIONS: readonly RegionInfo[] = [
  { code: 'all', name: 'Vereinigtes Königreich' },
] as const

export const REGION_NAME = 'Vereinigtes Königreich'

/** IMPORTANT: Auction House UK is a general commercial auctioneer, not a
 *  court/government forced-sale registry — there is no UK equivalent of the
 *  German ZVG. Its lots mix repossessions with voluntary, probate and
 *  developer sales, and are NOT reliably tagged by sale reason. This is the
 *  best available "distressed & general auction lots" feed for the UK, not a
 *  pure forced-sale source like most other crawlers in this project. */

/** The ~30 regional branch sites that together cover the UK; each renders
 *  every current lot for that branch on a single unpaginated page (verified
 *  live — no "?page=" links, no result-count truncation). Slugs taken from
 *  the site's own branch-picker dropdown, cross-checked against
 *  sitemap.xml. Two sitemap-only slugs (hertfordshireandwestessex,
 *  northwales) were dropped after confirming live they 301-redirect to
 *  /auctioneers — retired branch pages, now folded into bedsandbucks/wales
 *  respectively. */
export const GB_LIST_REGIONS: readonly string[] = [
  'bedsandbucks',
  'birmingham',
  'chesterfieldandnorthderbyshire',
  'coventryandwarwickshire',
  'cumbria',
  'eastanglia',
  'essex',
  'hullandeastyorkshire',
  'kent',
  'leicestershire',
  'lincolnshire',
  'london',
  'manchester',
  'midlands',
  'northamptonshire',
  'northeast',
  'northernireland',
  'northwest',
  'nottsandderby',
  'oxfordshire',
  'scotland',
  'southwest',
  'southyorkshire',
  'staffordshire',
  'sussexandhampshire',
  'teesvalley',
  'wales',
  'westyorkshire',
] as const

/** robots.txt (www.auctionhouse.co.uk) disallows these path patterns for all
 *  crawlers — enforced defensively when building links, even though none of
 *  our selectors currently point at them. */
export const DISALLOWED_MAIN_PATHS = [
  '/account/',
  '/print-lot/',
  '/files/',
  '/outbound/',
  '/local/',
  '/blog/',
  '/search-results',
  '/arrange-viewing/',
  '/home/',
  '/privacy-policy',
] as const

/** robots.txt (online.auctionhouse.co.uk) disallows these for all
 *  crawlers, plus declares Crawl-delay: 5 — every fetch against this host
 *  must be spaced out accordingly (see list.ts). Notably /asset-file-item/
 *  is off-limits; separately, the "Legal pack" links this platform exposes
 *  (both the /lot/legals/<id> path here and the legaldocuments.eigroup.co.uk
 *  path linked from the branch sites) 302-redirect to an account login for
 *  every lot we sampled, so the PDF itself is never actually reachable
 *  without an account — attachments are always left empty for that reason,
 *  not because of a robots.txt boundary. */
export const DISALLOWED_ONLINE_PATHS = [
  '/calendar/upcoming-auctions',
  '/error/',
  '/signalr',
  '/asset-file-item/',
] as const

export const ONLINE_CRAWL_DELAY_MS = 5_000
