import type { RegionInfo } from '../types'

export const AV_BASE = 'https://avoventes.fr'
export const COUNTRY = 'fr'
export const PLATFORM_ID = 'fr-avoventes'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/** AVOVENTES (the Conseil National des Barreaux' own national platform) has
 *  no user-facing sub-region filter — one national search covers all of
 *  France, same as licitor.com. */
export const AV_REGIONS: readonly RegionInfo[] = [
  { code: 'all', name: 'Frankreich' },
] as const

export const REGION_NAME = 'Frankreich'
