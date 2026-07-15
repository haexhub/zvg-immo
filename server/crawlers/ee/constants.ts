import type { RegionInfo } from '../types'

export const EE_BASE = 'https://www.oksjonikeskus.ee'
export const COUNTRY = 'ee'
export const PLATFORM_ID = 'ee-oksjonikeskus'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/** The Chamber of Bailiffs and Trustees in Bankruptcy runs one nationwide
 *  portal for all court-enforced sales — no per-office split needed. */
export const EE_REGIONS: readonly RegionInfo[] = [{ code: 'all', name: 'Estland' }] as const

/** varaliik=KI restricts to kinnisvara (real estate); offers=aktiiv to
 *  currently open/active lots (as opposed to under revaluation or archived). */
export const LIST_PATH = '/?varaliik=KI&offers=aktiiv'

export const DETAIL_CONCURRENCY = 5
