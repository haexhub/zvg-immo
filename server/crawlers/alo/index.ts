import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { ALO_REGIONS, BASE_URL, COUNTRY, PLATFORM_ID } from './constants'
import { fetchAllListings } from './list'
import { enrichOne } from './detail'

// opts is ignored: this crawler exposes a single nationwide 'all' scope (see
// constants.ts), so there is nothing to branch on — same convention as
// bcpea/index.ts.
async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const auctions = await fetchAllListings()

  return createCrawlResult({
    platform: PLATFORM_ID,
    source: BASE_URL,
    country: COUNTRY,
    regions: ALO_REGIONS,
    // No upstream-reported total exists: this crawls two category pages per
    // oblast and concatenates them, so the only number available is the
    // count of what was parsed. CrawlResult.totalReported is contractually
    // null when unknown or aggregated.
    totalReported: null,
    auctions,
  })
}

export const aloCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'alo.bg',
  baseUrl: BASE_URL,
  country: COUNTRY,
  regions: ALO_REGIONS,
  crawl,
  enrichOne,
}
