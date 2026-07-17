import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, LT_BASE, COUNTRY, LT_REGIONS } from './constants'
import { fetchAllListings } from './list'
import { enrichOne } from './detail'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: LT_BASE,
    country: COUNTRY,
    regions: LT_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const eaukcionaiCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Elektroninių varžytynių ir aukcionų portalas (Litauen)',
  baseUrl: LT_BASE,
  country: COUNTRY,
  regions: LT_REGIONS,
  crawl,
  enrichOne,
}
