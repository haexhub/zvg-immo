import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, GB_BASE, COUNTRY, GB_REGIONS, REGION_NAME } from './constants'
import { fetchAllListings } from './list'
import { enrichOne } from './detail'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    platformsSucceeded: [PLATFORM_ID],
    source: GB_BASE,
    countries: [COUNTRY],
    regions: [REGION_NAME],
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

export const auctionHouseCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Auction House UK (Vereinigtes Königreich)',
  baseUrl: GB_BASE,
  country: COUNTRY,
  regions: GB_REGIONS,
  crawl,
  enrichOne,
}
