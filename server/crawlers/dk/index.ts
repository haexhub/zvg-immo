import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, DK_BASE, COUNTRY, DK_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: DK_BASE,
    country: COUNTRY,
    regions: DK_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const tvangsauktionerCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Tvangsauktioner.dk (Dänemark)',
  baseUrl: DK_BASE,
  country: COUNTRY,
  regions: DK_REGIONS,
  crawl,
}
