import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { BASE_URL, BG_REGIONS, COUNTRY, PLATFORM_ID } from './constants'
import { fetchAllListings } from './list'
import { enrichOne } from './detail'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const auctions = await fetchAllListings()
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: BASE_URL,
    country: COUNTRY,
    regions: BG_REGIONS,
    // The site publishes no result-count total of its own; the only number
    // available is what was parsed off the paginated feed.
    totalReported: null,
    auctions,
  })
}

export const bulgarianHouseCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Bulgarian House (Immobilienagentur)',
  baseUrl: BASE_URL,
  country: COUNTRY,
  regions: BG_REGIONS,
  crawl,
  enrichOne,
}
