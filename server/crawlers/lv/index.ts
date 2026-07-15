import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, LV_BASE, COUNTRY, LV_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    source: LV_BASE,
    countries: [COUNTRY],
    regions: LV_REGIONS.map((r) => r.name),
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

export const eizsolesCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Elektronisko izsoļu vietne (Lettland)',
  baseUrl: LV_BASE,
  country: COUNTRY,
  regions: LV_REGIONS,
  crawl,
}
