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
 * Every offer carries a `federal_state` and the search API filters on it
 * server-side (`filters[federal_state]=<slug>`), so this adapter registers
 * the real Bundesländer instead of one nationwide pseudo-region: BImA objects
 * then show up under the same region filter as the court portals' listings,
 * and Germany's region list stays free of an entry that could match nothing.
 *
 * Codes are the project's existing German ones (zvg-portal/mv-zvgcom/dga-ag
 * already share them), so a region entry merges with theirs rather than
 * duplicating a state. The slugs are BImA's own enum values, read off the
 * complete live catalog (all 391 offers across every category, 2026-08-19) —
 * exactly these 16, no nulls and nothing outside them.
 */
const BIMA_STATES: readonly (readonly [code: string, name: string, federalState: string])[] = [
  ['bw', 'Baden-Württemberg', 'baden_wuerttemberg'],
  ['by', 'Bayern', 'bayern'],
  ['be', 'Berlin', 'berlin'],
  ['br', 'Brandenburg', 'brandenburg'],
  ['hb', 'Bremen', 'bremen'],
  ['hh', 'Hamburg', 'hamburg'],
  ['he', 'Hessen', 'hessen'],
  ['mv', 'Mecklenburg-Vorpommern', 'mecklenburg_vorpommern'],
  ['ni', 'Niedersachsen', 'niedersachsen'],
  ['nw', 'Nordrhein-Westfalen', 'nordrhein_westfalen'],
  ['rp', 'Rheinland-Pfalz', 'rheinland_pfalz'],
  ['sl', 'Saarland', 'saarland'],
  ['sn', 'Sachsen', 'sachsen'],
  ['st', 'Sachsen-Anhalt', 'sachsen_anhalt'],
  ['sh', 'Schleswig-Holstein', 'schleswig_holstein'],
  ['th', 'Thüringen', 'thueringen'],
] as const

export const BIMA_REGIONS: readonly RegionInfo[] = BIMA_STATES.map(([code, name]) => ({ code, name }))

/** Region code → the `filters[federal_state]` value to scope a crawl with. */
export const FEDERAL_STATE_BY_REGION_CODE: Record<string, string> = Object.fromEntries(
  BIMA_STATES.map(([code, , federalState]) => [code, federalState]),
)

/** `federal_state` → German region name, so a mapped offer carries the same
 *  Auction.region string the other German crawlers write. */
export const REGION_NAME_BY_FEDERAL_STATE: Record<string, string> = Object.fromEntries(
  BIMA_STATES.map(([, name, federalState]) => [federalState, name]),
)

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
