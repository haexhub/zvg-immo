import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, ZVGCOM_BASE, COUNTRY, MV_REGIONS } from './constants'
import { fetchAllListings } from './list'
import { enrichOne } from './detail'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    source: ZVGCOM_BASE,
    countries: [COUNTRY],
    regions: MV_REGIONS.map((r) => r.name),
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
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
