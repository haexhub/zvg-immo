import type { CrawlResult } from '~/types/auction'
import { isAllScope } from '~/lib/auction-constants'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { BIMA_REGIONS, COUNTRY, FEDERAL_STATE_BY_REGION_CODE, PLATFORM_ID, WEB_BASE } from './constants'
import { fetchAllListings } from './list'
import { findOne } from './detail'

/**
 * Scoped per Bundesland via the API's own `filters[federal_state]`, so the
 * scheduler's per-region passes each fetch only their own state instead of the
 * whole country 16 times over. An "all" scope (used by the permalink path)
 * asks for everything in one go.
 */
async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const all = isAllScope(opts.region)
  const federalState = all ? null : FEDERAL_STATE_BY_REGION_CODE[opts.region] ?? null
  if (!all && !federalState) {
    throw new Error(`bima: unbekannte Region "${opts.region}"`)
  }
  const regions = all ? BIMA_REGIONS : BIMA_REGIONS.filter((region) => region.code === opts.region)
  const { auctions, total } = await fetchAllListings(PLATFORM_ID, federalState)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: WEB_BASE,
    country: COUNTRY,
    regions,
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
