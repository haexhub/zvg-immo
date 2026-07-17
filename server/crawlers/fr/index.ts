import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, FR_BASE, COUNTRY, FR_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: FR_BASE,
    country: COUNTRY,
    regions: FR_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const licitorCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Licitor.com (Frankreich)',
  baseUrl: FR_BASE,
  country: COUNTRY,
  regions: FR_REGIONS,
  crawl,
}
