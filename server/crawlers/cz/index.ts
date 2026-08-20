import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { CZ_BASE, COUNTRY, PLATFORM_ID, CZ_REGIONS, LIST_ENDPOINTS } from './constants'
import { fetchEndpoint } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const settled = await Promise.allSettled(
    LIST_ENDPOINTS.map((path) => fetchEndpoint(path, PLATFORM_ID)),
  )

  const seen = new Set<string>()
  const auctions = []
  // One failed endpoint means its category's listings are entirely missing
  // from this run — that must not read as "crawled to completion", or a later
  // successful run would see them as newly gone rather than never fetched.
  let anyEndpointFailed = false
  for (const r of settled) {
    if (r.status === 'rejected') {
      anyEndpointFailed = true
      console.warn(`[${PLATFORM_ID}] endpoint failed: ${(r.reason as Error).message}`)
      continue
    }
    for (const a of r.value) {
      if (!seen.has(a.externalId)) {
        seen.add(a.externalId)
        auctions.push(a)
      }
    }
  }

  return {
    platform: PLATFORM_ID,
    platformsSucceeded: anyEndpointFailed ? [] : [PLATFORM_ID],
    source: CZ_BASE,
    countries: [COUNTRY],
    regions: [],
    fetchedAt: new Date().toISOString(),
    totalReported: null,
    auctions,
  }
}

export const czPortaldrazebCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Portál dražeb (Česká republika)',
  baseUrl: CZ_BASE,
  country: COUNTRY,
  regions: CZ_REGIONS,
  crawl,
}
