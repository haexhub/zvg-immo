import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, FR_BASE, COUNTRY, FR_REGIONS, REGION_NAME } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    source: FR_BASE,
    countries: [COUNTRY],
    regions: [REGION_NAME],
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

export const licitorCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Licitor.com (Frankreich)',
  baseUrl: FR_BASE,
  country: COUNTRY,
  regions: FR_REGIONS,
  crawl,
}
