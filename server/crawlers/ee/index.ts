import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, EE_BASE, COUNTRY, EE_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: EE_BASE,
    country: COUNTRY,
    regions: EE_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const oksjonikeskusCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Oksjonikeskus (Estland)',
  baseUrl: EE_BASE,
  country: COUNTRY,
  regions: EE_REGIONS,
  crawl,
}
