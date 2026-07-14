import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, CA_BASE, COUNTRY, CA_REGIONS, REGION_NAME } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    source: CA_BASE,
    countries: [COUNTRY],
    regions: [REGION_NAME],
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

export const ontarioTaxSalesCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Ontario Tax Sales (Kanada)',
  baseUrl: CA_BASE,
  country: COUNTRY,
  regions: CA_REGIONS,
  crawl,
}
