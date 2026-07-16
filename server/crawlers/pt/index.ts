import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, PT_BASE, COUNTRY, PT_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    source: PT_BASE,
    countries: [COUNTRY],
    regions: PT_REGIONS.map((r) => r.name),
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

export const eLeiloesCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'e-leilões (Portugal)',
  baseUrl: PT_BASE,
  country: COUNTRY,
  regions: PT_REGIONS,
  crawl,
}
