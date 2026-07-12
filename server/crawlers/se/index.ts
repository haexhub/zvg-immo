import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, SE_BASE, COUNTRY, SE_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    source: SE_BASE,
    countries: [COUNTRY],
    regions: SE_REGIONS.map((r) => r.name),
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

export const kronofogdenCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Auktionstorget Kronofogden (Schweden)',
  baseUrl: SE_BASE,
  country: COUNTRY,
  regions: SE_REGIONS,
  crawl,
}
