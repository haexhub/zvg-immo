import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, HU_BASE, COUNTRY, HU_REGIONS } from './constants'
import { fetchAllListings } from './list'
import { enrichOne } from './detail'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: HU_BASE,
    country: COUNTRY,
    regions: HU_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const mnvCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'MNV Elektronikus Aukciós Rendszer (Ungarn)',
  baseUrl: HU_BASE,
  country: COUNTRY,
  regions: HU_REGIONS,
  crawl,
  enrichOne,
}
