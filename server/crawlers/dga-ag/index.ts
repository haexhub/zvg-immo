import type { CrawlResult } from '~/types/auction'
import { isAllScope } from '~/lib/auction-constants'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { BASE_URL, COUNTRY, DGA_REGION_NAMES, DGA_REGIONS, PLATFORM_ID } from './constants'
import { fetchAllListings } from './list'
import { enrichOne } from './detail'

async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const auctions = await fetchAllListings()
  const all = isAllScope(opts.region)
  const regionName = DGA_REGION_NAMES[opts.region]
  const scoped = all ? auctions : auctions.filter((a) => a.region === regionName)

  return {
    platform: PLATFORM_ID,
    platformsSucceeded: [PLATFORM_ID],
    source: BASE_URL,
    countries: [COUNTRY],
    regions: all ? DGA_REGIONS.map((r) => r.name) : [regionName ?? opts.region],
    fetchedAt: new Date().toISOString(),
    // dga-ag.de publishes no result count of its own; the page just renders
    // every object. The only number available is what was parsed (and, for a
    // scoped crawl, what survived the Bundesland filter), which is not what
    // CrawlResult.totalReported means — it is contractually null when the
    // upstream total is unknown.
    totalReported: null,
    auctions: scoped,
  }
}

export const dgaAgCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'DGA AG (Immobilienauktionen)',
  baseUrl: BASE_URL,
  country: COUNTRY,
  regions: DGA_REGIONS,
  crawl,
  enrichOne,
}
