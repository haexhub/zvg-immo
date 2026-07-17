import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, SI_BASE, COUNTRY, SI_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: SI_BASE,
    country: COUNTRY,
    regions: SI_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const sodneDrazbeCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Portal sodnih dražb (Slowenien)',
  baseUrl: SI_BASE,
  country: COUNTRY,
  regions: SI_REGIONS,
  crawl,
}
