import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, DK_BASE, COUNTRY, DK_REGIONS, REGION_NAME } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    source: DK_BASE,
    countries: [COUNTRY],
    regions: [REGION_NAME],
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

export const tvangsauktionerCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Tvangsauktioner.dk (Dänemark)',
  baseUrl: DK_BASE,
  country: COUNTRY,
  regions: DK_REGIONS,
  crawl,
}
