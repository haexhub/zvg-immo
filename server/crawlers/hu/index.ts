import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, HU_BASE, COUNTRY, HU_REGIONS } from './constants'
import { fetchAllListings } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    source: HU_BASE,
    countries: [COUNTRY],
    regions: ['Ungarn'],
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

export const mnvCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'MNV Elektronikus Aukciós Rendszer (Ungarn)',
  baseUrl: HU_BASE,
  country: COUNTRY,
  regions: HU_REGIONS,
  crawl,
}
