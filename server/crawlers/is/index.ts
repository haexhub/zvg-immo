import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, IS_BASE, COUNTRY, IS_REGIONS, REGION_NAME } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    source: IS_BASE,
    countries: [COUNTRY],
    regions: [REGION_NAME],
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

export const syslumennCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Sýslumenn (Island)',
  baseUrl: IS_BASE,
  country: COUNTRY,
  regions: IS_REGIONS,
  crawl,
}
