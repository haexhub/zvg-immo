import type { RegionInfo } from '../types'

export const BIDDIT_BASE = 'https://www.biddit.be'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

export const COUNTRY = 'be'

/** Biddit doesn't expose a region/province filter on the public search API,
 *  and the entire active inventory (~400 forced sales nation-wide) fits
 *  comfortably in a single paginated fetch — so we model BE as one region. */
export const BE_REGIONS: readonly RegionInfo[] = [
  { code: 'all', name: 'Belgien' },
] as const

/** Display name shown alongside auctions. */
export const REGION_NAME = 'Belgien'

/** Filter value for `handlingMethods` on the search endpoint. Biddit also
 *  hosts ONLINE_PRIVATE_SALE (voluntary) and ONLINE_PRIVATE_ANNUITY (rente
 *  viagère / lijfrente) auctions; only the public ones are court-ordered
 *  forced sales and therefore in scope here. */
export const HANDLING_METHOD_PUBLIC = 'ONLINE_PUBLIC_SALE'

/** Hard server cap; requesting more than 30 silently returns 30. */
export const PAGE_SIZE = 30
