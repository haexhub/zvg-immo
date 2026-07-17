import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, ZVGCOM_BASE, COUNTRY, MV_REGIONS } from './constants'
import { fetchAllListings } from './list'
import { enrichOne } from './detail'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: ZVGCOM_BASE,
    country: COUNTRY,
    regions: MV_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const mvZvgcomCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'ZVG.com (Mecklenburg-Vorpommern)',
  baseUrl: ZVGCOM_BASE,
  country: COUNTRY,
  regions: MV_REGIONS,
  crawl,
  enrichOne,
}
