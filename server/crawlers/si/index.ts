import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, SI_BASE, COUNTRY, SI_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    source: SI_BASE,
    countries: [COUNTRY],
    regions: SI_REGIONS.map((r) => r.name),
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

export const sodneDrazbeCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Portal sodnih dražb (Slowenien)',
  baseUrl: SI_BASE,
  country: COUNTRY,
  regions: SI_REGIONS,
  crawl,
}
