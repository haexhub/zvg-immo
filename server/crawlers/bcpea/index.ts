import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { BASE_URL, BCPEA_REGIONS, COUNTRY, PLATFORM_ID } from './constants'
import { fetchAllListings } from './list'
import { enrichOne } from './detail'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: BASE_URL,
    country: COUNTRY,
    regions: BCPEA_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const bcpeaCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Камара на частните съдебни изпълнители (Bulgarien)',
  baseUrl: BASE_URL,
  country: COUNTRY,
  regions: BCPEA_REGIONS,
  crawl,
  enrichOne,
}
