import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { ALO_REGIONS, BASE_URL, COUNTRY, PLATFORM_ID } from './constants'
import { fetchAllListings } from './list'
import { enrichOne } from './detail'

// opts is ignored: this crawler exposes a single nationwide 'all' scope (see
// constants.ts), so there is nothing to branch on — unlike kip/index.ts, which
// filters its regions by opts.region because it registers real sub-regions.
async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const auctions = await fetchAllListings()

  return createCrawlResult({
    platform: PLATFORM_ID,
    source: BASE_URL,
    country: COUNTRY,
    regions: ALO_REGIONS,
    // Each list page does report its own category/oblast total ("10325
    // обяви"), but this crawl concatenates four of those scopes, so no single
    // upstream number describes the result. CrawlResult.totalReported is
    // contractually null when unknown or aggregated.
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
