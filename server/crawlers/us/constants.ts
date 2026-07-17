import type { RegionInfo } from '../types'

export const US_BASE = 'https://www.bid4assets.com'
export const COUNTRY = 'us'
export const PLATFORM_ID = 'us-bid4assets'
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Bid4Assets has no robots.txt (confirmed: HTTP 404) and no user-facing
 *  state/region filter of its own — coverage is a hand-picked list of
 *  individual county/parish "seller channels" (see US_CHANNELS below), not a
 *  full enumeration of US counties (most US counties don't sell through
 *  Bid4Assets at all). Exposing per-state RegionInfo entries would imply
 *  comprehensive state coverage (e.g. "all of Pennsylvania"), which would be
 *  false: only 16 of PA's 67 counties run sheriff sales through this
 *  platform, and several states have just one county each. A single
 *  collapsed region — the same convention used by FR/PL/CZ/HU/SI/… for
 *  platforms without a real sub-region filter — is the honest choice here.
 *  The real per-listing county/state is still preserved on each Auction via
 *  `region` and `amtsgericht`, parsed from that listing's own
 *  "<County>, <ST> Sheriff Sale: …" title (see parseCountyState in list.ts). */
export const US_REGIONS: readonly RegionInfo[] = [{ code: 'all', name: 'USA' }] as const

/**
 * Curated list of Bid4Assets county/parish sheriff-sale channel paths (under
 * US_BASE), taken from the site's own `/sheriffsales` directory page — not
 * invented. Bid4Assets runs judicial sheriff sales for many, but far from
 * all, US counties; there is no practical way to "discover" every
 * participating county programmatically, so — mirroring how the Canada
 * crawler scopes down to Ontario only — this list is intentionally limited
 * to the channels Bid4Assets itself currently lists as active sellers.
 *
 * Out of scope for this pass (documented, not an oversight):
 * - Tax lien/tax deed sales (`/county-tax-sales`) and HUD homes
 *   (`berkshudpa`, `chesterhudpa`, `phillyhudpa`) — different legal
 *   instrument than a judicial foreclosure sale; mixing them into the same
 *   Auction shape (aktenzeichen = court case number, amtsgericht = sheriff)
 *   would misrepresent what's actually being sold.
 * - `/philadelphia`: unlike every channel below, it doesn't embed a single
 *   listings grid directly — it fans out into several `/channel/<id>`
 *   sub-pages, which would need a different parser and extra requests for
 *   one jurisdiction.
 */
export const US_CHANNELS: readonly string[] = [
  // Pennsylvania
  'adamscountysheriffsales',
  'armstrongpasheriffsales',
  'beavercountypasheriffsales',
  'BedfordPASheriffSales',
  'berkscountysheriffsales',
  'BradfordPASheriffSales',
  'CameronPASheriffSales',
  'CarbonPASheriffSales',
  'chestercopasheriffsales',
  'ColumbiaPASheriffSales',
  'elksheriffsales',
  'franklincountypasheriffsales',
  'IndianaCountyPASheriff',
  'monroecountysheriffsales',
  'MontcoPASheriff',
  'SchuylkillSheriffSales',
  // Washington
  'chelancountysheriffsales',
  'graysharborsheriffsales',
  // Louisiana
  'BossierSheriff',
  'CPSOSheriff',
  'ebrsosheriffsales',
  'LPSOSheriff',
  'ouachitasheriffsales',
  'tangipahoalasheriffsales',
  'vermilionsheriffsales',
  'vernonsheriffsales',
  'WPSOSheriffSales',
  // Wisconsin
  'MilwaukeeSheriffSales',
  // Florida
  'OkaloosaFL',
  'pbsosheriffsales',
  // Oklahoma
  'OKCSheriff',
] as const

/** USPS state abbreviation -> full name, for the 2-letter code parsed out of
 *  each listing's own title (e.g. "Franklin County, PA Sheriff Sale: …"). */
export const US_STATE_NAMES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  DC: 'District of Columbia',
} as const
