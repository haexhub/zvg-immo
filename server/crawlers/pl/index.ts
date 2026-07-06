import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PL_BASE, COUNTRY, PLATFORM_ID, FILTER_REAL_ESTATE, PL_REGIONS } from './constants'
import { fetchFilterPage } from './list'

const MAX_PAGES = 50 // safety cap — each page typically holds 20 listings

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const auctions = []
  let totalReported: number | null = null
  let page = 1

  while (page <= MAX_PAGES) {
    const result = await fetchFilterPage(FILTER_REAL_ESTATE, page, PLATFORM_ID)

    if (page === 1) totalReported = result.totalReported
    auctions.push(...result.auctions)

    if (!result.hasNextPage || result.auctions.length === 0) break
    page++
  }

  // Deduplicate by zvgId (defensive — pages can overlap near boundaries).
  const seen = new Set<string>()
  const unique = auctions.filter((a) => {
    if (seen.has(a.zvgId)) return false
    seen.add(a.zvgId)
    return true
  })

  return {
    platform: PLATFORM_ID,
    source: PL_BASE,
    countries: [COUNTRY],
    regions: [],
    fetchedAt: new Date().toISOString(),
    totalReported,
    auctions: unique,
  }
}

export const plKomornikCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Licytacje Komornicze (Krajowa Rada Komornicza)',
  baseUrl: PL_BASE,
  country: COUNTRY,
  regions: PL_REGIONS,
  crawl,
}
