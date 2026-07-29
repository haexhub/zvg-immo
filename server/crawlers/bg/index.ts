import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, BG_BASE, COUNTRY, BG_REGIONS } from './constants'
import { fetchAllListings } from './list'
import { enrichOne } from './detail'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: BG_BASE,
    country: COUNTRY,
    regions: BG_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const zaporiCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Единен портал за електронни публични търгове (Bulgarien)',
  baseUrl: BG_BASE,
  country: COUNTRY,
  regions: BG_REGIONS,
  crawl,
  enrichOne,
}
