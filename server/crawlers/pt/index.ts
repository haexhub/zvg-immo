import type { Auction, CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, PT_BASE, COUNTRY, PT_REGIONS } from './constants'
import { fetchAllListings } from './list'
import { fetchEventoDetail, applyDetail } from './detail'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: PT_BASE,
    country: COUNTRY,
    regions: PT_REGIONS,
    totalReported: total,
    auctions,
  })
}

async function enrichOne(auction: Auction): Promise<void> {
  // The e-leilões referencia keys the per-evento detail endpoint
  // (/api/Eventos/<referencia>); the list stores it in the detail URL
  // (/evento/<referencia>) because caseNumber holds the court case number.
  const referencia = auction.detailUrlUpstream?.split('/evento/')[1]
  if (!referencia) return
  const item = await fetchEventoDetail(referencia)
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
