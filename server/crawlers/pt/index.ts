import type { Auction, CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, PT_BASE, COUNTRY, PT_REGIONS } from './constants'
import { fetchAllListings } from './list'
import { fetchEventoDetail, applyDetail } from './detail'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    source: PT_BASE,
    countries: [COUNTRY],
    regions: PT_REGIONS.map((r) => r.name),
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

async function enrichOne(auction: Auction): Promise<void> {
  // aktenzeichen carries the e-leilões referencia — the key of the per-evento
  // detail endpoint (/api/Eventos/<referencia>).
  if (!auction.aktenzeichen) return
  const item = await fetchEventoDetail(auction.aktenzeichen)
  applyDetail(auction, item)
}

export const eLeiloesCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'e-leilões (Portugal)',
  baseUrl: PT_BASE,
  country: COUNTRY,
  regions: PT_REGIONS,
  crawl,
  enrichOne,
}
