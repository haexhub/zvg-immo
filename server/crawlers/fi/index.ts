import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, FI_BASE, COUNTRY, FI_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: FI_BASE,
    country: COUNTRY,
    regions: FI_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const huutokaupatCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Huutokaupat.com (Ulosottolaitos, Finnland)',
  baseUrl: FI_BASE,
  country: COUNTRY,
  regions: FI_REGIONS,
  crawl,
}
