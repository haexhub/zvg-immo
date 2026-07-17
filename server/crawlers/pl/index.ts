import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PL_BASE, COUNTRY, PLATFORM_ID, LIST_PAGE_SIZE, PL_REGIONS } from './constants'
import { fetchListPage } from './list'
import { enrichOne } from './detail'

const MAX_PAGES = 50 // safety cap — 100 listings per page

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const auctions = []
  let page = 0

  while (page < MAX_PAGES) {
    const result = await fetchListPage(page * LIST_PAGE_SIZE, PLATFORM_ID)
    auctions.push(...result.auctions)

    // hasNextPage relies on the SSR pagination widget — if its selectors stop
    // matching after another site change, the crawl would silently stop at one
    // page. Make that failure mode visible.
    if (result.auctions.length > 0 && (result.currentPage == null || result.lastPage == null)) {
      console.warn('[pl-komornik] pagination widget not found — crawl may be truncated to one page')
    }
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
    totalReported: null,
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
  enrichOne,
}
