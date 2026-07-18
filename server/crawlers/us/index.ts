import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, US_BASE, COUNTRY, US_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  const regions = [...new Set(auctions.map((a) => a.region).filter(Boolean))].sort()

  return {
    platform: PLATFORM_ID,
    source: US_BASE,
    countries: [COUNTRY],
    regions,
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

export const bid4assetsCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Bid4Assets (USA)',
  baseUrl: US_BASE,
  country: COUNTRY,
  regions: US_REGIONS,
  crawl,
}
