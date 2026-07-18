import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, IS_BASE, COUNTRY, IS_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: IS_BASE,
    country: COUNTRY,
    regions: IS_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const syslumennCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Sýslumenn (Island)',
  baseUrl: IS_BASE,
  country: COUNTRY,
  regions: IS_REGIONS,
  crawl,
}
