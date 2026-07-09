import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, LT_BASE, COUNTRY, LT_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    source: LT_BASE,
    countries: [COUNTRY],
    regions: LT_REGIONS.map((r) => r.name),
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

export const eaukcionaiCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Elektroninių varžytynių ir aukcionų portalas (Litauen)',
  baseUrl: LT_BASE,
  country: COUNTRY,
  regions: LT_REGIONS,
  crawl,
}
