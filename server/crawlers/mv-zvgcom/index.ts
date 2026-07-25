import type { CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, ZVGCOM_BASE, COUNTRY, ZVGCOM_REGIONS, ZVGCOM_STATES } from './constants'
import { fetchStateListings } from './list'
import { enrichOne } from './detail'

// One shared crawler is registered for 3 regions (hh/mv/sh — see constants.ts),
// but each is a separate zvg.com state endpoint. `crawlSingle`/`crawlAll` invoke
// `crawl()` once per region (opts.region), so scoping to the requested state
// here is required — fetching all 3 regardless of opts.region previously made
// every one of the 3 region entries cache the identical combined dataset,
// tripling each listing in the merged search results (and the upstream fetch).
async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const state = ZVGCOM_STATES.find((s) => s.code === opts.region)
  if (!state) {
    throw new Error(`zvg.com: unbekannte Region "${opts.region}"`)
  }
  const auctions = await fetchStateListings(state, PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: ZVGCOM_BASE,
    country: COUNTRY,
    regions: [state],
    totalReported: auctions.length,
    auctions,
  })
}

export const mvZvgcomCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'ZVG.com (Hamburg, Mecklenburg-Vorpommern, Schleswig-Holstein)',
  baseUrl: ZVGCOM_BASE,
  country: COUNTRY,
  regions: ZVGCOM_REGIONS,
  crawl,
  enrichOne,
}
