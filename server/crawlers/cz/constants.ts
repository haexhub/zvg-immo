export const CZ_BASE = 'https://www.portaldrazeb.cz'
export const COUNTRY = 'cz'
export const PLATFORM_ID = 'cz-portaldrazeb'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const CZ_REGIONS = [{ code: 'all', name: 'Tschechien' }] as const

/** Both endpoints cover forced real-estate auctions: upcoming and currently live. */
export const LIST_ENDPOINTS = [
  '/drazby/pripravovane.json',
  '/drazby/online.json',
] as const

/** The .json endpoints only serve the CSRF-authenticated PUT/filter request
 *  (a plain GET always returns the same fixed first page); a large limit
 *  covers today's volumes (~700) in one request, with the loop in list.ts
 *  paginating further if a response ever comes back full. */
export const CZ_LIST_LIMIT = 1000
export const CZ_MAX_LIST_PAGES = 20
