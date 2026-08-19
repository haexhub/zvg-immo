import type { RegionInfo } from '../types'

export const PLATFORM_ID = 'bima'
export const COUNTRY = 'de'
export const AUTHORITY = 'Bundesanstalt für Immobilienaufgaben (BImA)'

/** Public-facing SPA — used for attribution and detailUrl construction. The
 *  actual data comes from API_BASE below, a separate host the SPA itself
 *  calls (see list.ts); this is not the endpoint fetched. */
export const WEB_BASE = 'https://immobilienportal.bundesimmobilien.de'

/**
 * The SPA's own backend for its results grid — confirmed live by observing
 * the network requests a real page load makes (`GET .../search?...`) and by
 * fetching it directly with no cookies/auth/Referer: it returns clean
 * JSON:API data (200) with no gate at all. This is not a private/internal
 * endpoint being reverse-engineered around an access control — it's the
 * exact call every anonymous visitor's browser makes to render the page.
 */
export const API_BASE = 'https://apis.bundesimmobilien.de/immo/real_estate_offers'

/**
 * BImA exposes no user-facing sub-region filter of its own on the results
 * page (only a free-text place/postcode search and a radius) — same
 * "collapse to one region" precedent as gb/auctionhouse and bg/zapori. The
 * API itself paginates the whole nationwide result set, so one crawl call
 * covers the country regardless of how many Bundesländer the ~20-ish BUY
 * listings currently span.
 */
export const BIMA_REGIONS: readonly RegionInfo[] = [{ code: 'all', name: 'Bundesweit' }] as const

/**
 * Scope of this first adapter: residential ("Wohnimmobilien") for-sale
 * listings only. `living` also carries RENT listings (Kaltmiete) — excluded
 * here because `Auction.marketValueEur` models a one-off value, not a
 * recurring rent, the same reasoning that keeps rental listings out of every
 * other crawler in this project. Gewerbe/Land&Forst/Wohnungsfürsorge
 * (business/forest/government_living) are left for a follow-up PR.
 */
export const CATEGORY = 'living'
export const COMMERCIALIZATION_TYPE = 'BUY'

/** Comfortably above the current ~20-listing total for living/BUY — even if
 *  the API caps page_size lower than requested, fetchAllListings (list.ts)
 *  keeps paging via meta.total until every offer has been collected. */
export const PAGE_SIZE = 100

export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'
