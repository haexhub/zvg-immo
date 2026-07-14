import type { RegionInfo } from '../types'

export const CA_BASE = 'https://www.ontariotaxsales.ca'
export const COUNTRY = 'ca'
export const PLATFORM_ID = 'ca-ontariotaxsales'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/** Index of all upcoming Ontario municipal tax sales. Each links to one
 *  municipality's dated sale page (/tax-sales/{municipality}-{YYYY-MM-DD}/),
 *  which lists one or more properties offered by public tender. */
export const INDEX_URL = `${CA_BASE}/upcoming-ontario-tax-sales/`

/** Ontario is the only Canadian province where municipal tax sales are
 *  published as a public, structured, server-rendered feed — it holds
 *  effectively all publicly crawlable Canadian tax-sale data. */
export const CA_REGIONS: readonly RegionInfo[] = [
  { code: 'on', name: 'Ontario' },
] as const

export const REGION_NAME = 'Ontario'
