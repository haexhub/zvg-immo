import type { RegionInfo } from '../types'

export const DK_BASE = 'https://www.tvangsauktioner.dk'
export const COUNTRY = 'dk'
export const PLATFORM_ID = 'dk-tvangsauktioner'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/** WordPress admin-ajax endpoint backing the search-map block; POSTing
 *  `action=get_all_posts_ajax` with no filters returns every active auction
 *  nationwide in one call. */
export const AJAX_URL = `${DK_BASE}/wp-admin/admin-ajax.php`

/** Tvangsauktioner.dk aggregates all 24 Danish court districts (retskredse)
 *  nationwide behind a single search endpoint — no per-court split needed. */
export const DK_REGIONS: readonly RegionInfo[] = [
  { code: 'all', name: 'Dänemark' },
] as const

export const REGION_NAME = 'Dänemark'
