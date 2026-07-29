import type { RegionInfo } from '../types'

export const BG_BASE = 'https://zapori.mjs.bg'
export const BG_API_BASE = 'https://zapori.mjs.bg/api'
export const COUNTRY = 'bg'
export const PLATFORM_ID = 'bg-zapori'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** The Ministry of Justice's unified e-auction system (replacing the
 *  fragmented per-court "Публични продажби" pages) exposes no per-region
 *  filter of its own — /api/announcements always returns every currently
 *  active nationwide listing in one call. */
export const BG_REGIONS: readonly RegionInfo[] = [{ code: 'all', name: 'Bulgarien' }] as const

/** propertyType value for real estate lots; the same endpoint also lists
 *  "моторно превозно средство" (vehicles) and "друга" (other movables). */
export const REAL_ESTATE_PROPERTY_TYPE = 'имот'
