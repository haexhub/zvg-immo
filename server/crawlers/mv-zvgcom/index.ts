import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, ZVGCOM_BASE, COUNTRY, ZVGCOM_REGIONS } from './constants'
import { fetchAllListings } from './list'
import { enrichOne } from './detail'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: ZVGCOM_BASE,
    country: COUNTRY,
    regions: ZVGCOM_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const mvZvgcomCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'ZVG.com (Hamburg, Mecklenburg-Vorpommern, Schleswig-Holstein)',
  baseUrl: ZVGCOM_BASE,
  country: COUNTRY,
  regions: ZVGCOM_REGIONS,
  crawl,
  enrichOne,
}
