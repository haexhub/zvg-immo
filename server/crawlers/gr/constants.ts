import type { RegionInfo } from '../types'

export const GR_BASE = 'https://eauction24.gr'
export const COUNTRY = 'gr'
export const PLATFORM_ID = 'gr-eauction24'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/** eauction24.gr exposes no crawlable per-region filter of its own — region
 *  (Greek "Περιφέρεια") is scraped per-listing from the address instead and
 *  only used for display; the sitemap already enumerates every active lot
 *  nationwide, so a single national entry covers the whole crawl. */
export const GR_REGIONS: readonly RegionInfo[] = [{ code: 'all', name: 'Griechenland' }] as const

/** Lists every currently active auction (the site's own count matches this
 *  sitemap's size — see list.ts); a separate listings.xml covers ordinary
 *  for-sale properties (/listing/…) and must not be crawled here. */
export const SITEMAP_URL = `${GR_BASE}/auctions.xml`

export const DETAIL_CONCURRENCY = 6
