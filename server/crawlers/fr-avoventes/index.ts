import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, AV_BASE, COUNTRY, AV_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: AV_BASE,
    country: COUNTRY,
    regions: AV_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const avoventesCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'AVOVENTES.fr (Frankreich)',
  baseUrl: AV_BASE,
  country: COUNTRY,
  regions: AV_REGIONS,
  crawl,
}
