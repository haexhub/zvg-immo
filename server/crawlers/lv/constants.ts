import type { RegionInfo } from '../types'

export const LV_BASE = 'https://izsoles.ta.gov.lv'
export const COUNTRY = 'lv'
export const PLATFORM_ID = 'lv-eizsoles'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/** The Court Administration (Tiesu administrācija) runs one nationwide portal
 *  for all sworn-bailiff auctions — no per-district split needed. */
export const LV_REGIONS: readonly RegionInfo[] = [{ code: 'all', name: 'Lettland' }] as const

/** The search form is submitted via a JS click handler (button has no
 *  type="submit"), so a plain GET/POST with query params is ignored — the
 *  filter has to be set once via POST (type=1 real estate,
 *  announcement_filter_state_mask=1 "Notiek izsole" = ongoing) and then
 *  persists server-side in the ci_session cookie for subsequent page fetches. */
export const FILTER_BODY = {
  type: '1',
  announcement_filter_state_mask: '1',
  'init-search-full': 'on',
}

export const MAX_LIST_PAGES = 150
