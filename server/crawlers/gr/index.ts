import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, GR_BASE, COUNTRY, GR_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    source: GR_BASE,
    countries: [COUNTRY],
    regions: GR_REGIONS.map((r) => r.name),
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

export const eauction24Crawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'eAuction24 (Griechenland)',
  baseUrl: GR_BASE,
  country: COUNTRY,
  regions: GR_REGIONS,
  crawl,
}
