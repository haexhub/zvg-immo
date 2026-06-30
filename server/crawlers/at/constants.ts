import type { RegionInfo } from '../types'

export const AT_BASE = 'https://edikte.justiz.gv.at'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

export const COUNTRY = 'at'

/**
 * Bundesländer as exposed by edikte.justiz.gv.at. The portal addresses them
 * with a numeric `BL` parameter (0–8, see PORTAL_BL_CODES below); we expose
 * canonical short codes outwards.
 */
export const AT_REGIONS: readonly RegionInfo[] = [
  { code: 'bgld', name: 'Burgenland' },
  { code: 'ktn', name: 'Kärnten' },
  { code: 'noe', name: 'Niederösterreich' },
  { code: 'ooe', name: 'Oberösterreich' },
  { code: 'sbg', name: 'Salzburg' },
  { code: 'stmk', name: 'Steiermark' },
  { code: 'tirol', name: 'Tirol' },
  { code: 'vbg', name: 'Vorarlberg' },
  { code: 'wien', name: 'Wien' },
] as const

/** Maps the canonical region code to the portal's numeric BL value.
 *  These numbers come from the <select name="BL"> options on the advanced
 *  search form and are not aligned with ISO 3166-2:AT. */
export const PORTAL_BL_CODES: Record<string, string> = {
  bgld: '2',
  ktn: '6',
  noe: '1',
  ooe: '3',
  sbg: '4',
  stmk: '5',
  tirol: '7',
  vbg: '8',
  wien: '0',
}

export const AT_REGION_NAMES: Record<string, string> = Object.fromEntries(
  AT_REGIONS.map((r) => [r.code, r.name]),
)
