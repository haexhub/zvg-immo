import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, SE_BASE, COUNTRY, SE_REGIONS } from './constants'
import { fetchAllListings, fetchListingById } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: SE_BASE,
    country: COUNTRY,
    regions: SE_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const kronofogdenCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Auktionstorget Kronofogden (Schweden)',
  baseUrl: SE_BASE,
  country: COUNTRY,
  regions: SE_REGIONS,
  crawl,
  findOne: (externalId) => fetchListingById(externalId, PLATFORM_ID),
}
