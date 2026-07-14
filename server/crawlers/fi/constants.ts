import type { RegionInfo } from '../types'

export const FI_BASE = 'https://huutokaupat.com'
export const COUNTRY = 'fi'
export const PLATFORM_ID = 'fi-huutokaupat'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/** Ulosottolaitos (Finnish National Enforcement Authority) has no regional
 *  sub-portals of its own — all forced sales are auctioned nationally on the
 *  huutokaupat.com marketplace, pre-filtered to the "ulosotto" seller group. */
export const FI_REGIONS: readonly RegionInfo[] = [
  { code: 'all', name: 'Finnland' },
] as const

export const REGION_NAME = 'Finnland'

/** Listing page pre-filtered to Ulosottolaitos-organised auctions (mix of real
 *  estate, vehicles, boats, …). Paginated via `?sivu=N`. */
export const LIST_URL = `${FI_BASE}/ilmoittaja/ulosotto`

/** Only entries the detail API tags as real estate (excludes vehicles, boats,
 *  electronics, … that Ulosottolaitos also auctions off via this platform). */
export const REAL_ESTATE_CATEGORY = 'RealEstate'
