export const LT_BASE = 'https://www.eaukcionai.lt'
export const COUNTRY = 'lt'
export const PLATFORM_ID = 'lt-eaukcionai'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const LT_REGIONS = [{ code: 'all', name: 'Litauen' }] as const

// ?page= is 0-indexed; estateType=1 = real estate; stateType restricts to announced+ongoing
export const LIST_PATH =
  '/evs/pages/auctions.do?listType=1&estateType=1&stateType=PASKELBTA-IR-VYKSTA&page='
