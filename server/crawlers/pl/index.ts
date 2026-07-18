import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PL_BASE, COUNTRY, PLATFORM_ID, LIST_PAGE_SIZE, PL_REGIONS } from './constants'
import { fetchListPage } from './list'
import { enrichOne } from './detail'

const MAX_PAGES = 50 // safety cap — 100 listings per page

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const auctions = []
  let offset = 0

  for (let pages = 1; ; pages++) {
    const result = await fetchListPage(offset, PLATFORM_ID)
    auctions.push(...result.auctions)

    // hasNextPage relies on the SSR pagination widget — if its selectors stop
    // matching after another site change, the crawl would silently stop at one
    // page. Make that failure mode visible.
    if (result.auctions.length > 0 && (result.currentPage == null || result.lastPage == null)) {
      console.warn('[pl-komornik] pagination widget not found — crawl may be truncated to one page')
    }
    if (!result.hasNextPage || result.auctions.length === 0) break
    if (pages >= MAX_PAGES) {
      console.warn(
        `[pl-komornik] safety cap of ${MAX_PAGES} pages hit at page ${result.currentPage}/${result.lastPage} — crawl truncated`,
      )
      break
    }
    // Advance by the number of cards actually delivered: if the server ever
    // stops honouring ?limit=100 (e.g. falls back to its 20-per-page default),
    // fixed LIST_PAGE_SIZE steps would silently skip most listings. Overlapping
    // windows this may produce are deduped below.
    if (result.auctions.length !== LIST_PAGE_SIZE) {
      console.warn(
        `[pl-komornik] page delivered ${result.auctions.length} cards (limit=${LIST_PAGE_SIZE}) — advancing offset by the delivered count`,
      )
    }
    offset += result.auctions.length
  }

  // Deduplicate by externalId (defensive — pages can overlap near boundaries).
  const seen = new Set<string>()
  const unique = auctions.filter((a) => {
    if (seen.has(a.externalId)) return false
    seen.add(a.externalId)
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
