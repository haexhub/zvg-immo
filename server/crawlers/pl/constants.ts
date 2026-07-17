export const PL_BASE = 'https://licytacje.komornik.pl'
export const COUNTRY = 'pl'
export const PLATFORM_ID = 'pl-komornik'

/** SSR search page for real-estate auction notices. The pre-2026
 *  /Notice/Filter/* endpoints redirect (302) here since the site migration. */
export const LIST_PATH = '/wyszukiwarka/obwieszczenia-o-licytacji'

/** Cards per page — the SSR page honours ?limit= (UI offers 20/50/100). */
export const LIST_PAGE_SIZE = 100

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const PL_REGIONS = [{ code: 'all', name: 'Polen' }] as const
