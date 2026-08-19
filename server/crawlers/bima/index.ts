import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { BIMA_REGIONS, COUNTRY, PLATFORM_ID, WEB_BASE } from './constants'
import { fetchAllListings } from './list'
import { findOne } from './detail'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: WEB_BASE,
    country: COUNTRY,
    regions: BIMA_REGIONS,
    totalReported: total,
    auctions,
  })
}

export const bimaCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Immobilienportal der Bundesanstalt für Immobilienaufgaben (BImA)',
  baseUrl: WEB_BASE,
  country: COUNTRY,
  regions: BIMA_REGIONS,
  crawl,
  findOne: (externalId) => findOne(externalId, PLATFORM_ID),
}
