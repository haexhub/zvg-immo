import type { CrawlResult } from '~/types/auction'
import { isAllScope } from '~/lib/auction-constants'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { BASE_URL, COUNTRY, KIP_REGIONS, PLATFORM_ID } from './constants'
import { fetchRegionListings } from './list'
import { enrichOne } from './detail'

async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const all = isAllScope(opts.region)
  const regions = all ? KIP_REGIONS : KIP_REGIONS.filter((r) => r.code === opts.region)

  const auctions = []
  for (const region of regions) {
    auctions.push(...(await fetchRegionListings(region)))
  }

  return {
    platform: PLATFORM_ID,
    source: BASE_URL,
    countries: [COUNTRY],
    regions: regions.map((r) => r.name),
    fetchedAt: new Date().toISOString(),
    // No upstream-reported total exists: this crawls three category pages per
    // state and concatenates them, so the only number available is the count
    // of what was parsed. CrawlResult.totalReported is contractually null when
    // unknown or aggregated.
    totalReported: null,
    auctions,
  }
}

export const kipCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'KIP.net (kommunale Immobilienplattform)',
  baseUrl: BASE_URL,
  country: COUNTRY,
  regions: KIP_REGIONS,
  crawl,
  enrichOne,
}
