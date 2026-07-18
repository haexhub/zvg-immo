import type { Auction, CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, CA_BASE, COUNTRY, CA_REGIONS } from './constants'
import { fetchAllListings, htmlFetch, parsePropertyPage } from './list'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: CA_BASE,
    country: COUNTRY,
    regions: CA_REGIONS,
    totalReported: total,
    auctions,
  })
}

async function enrichOne(auction: Auction): Promise<void> {
  // Only dedicated /property/ pages carry the fact table + gallery; some lots
  // have no detail link at all. Host-anchored: detail URLs are resolved from
  // anchors on crawled pages, and only ontariotaxsales.ca must be fetched.
  if (!auction.detailUrlUpstream?.startsWith(`${CA_BASE}/property/`)) return
  const detail = parsePropertyPage(await htmlFetch(auction.detailUrlUpstream))

  if (detail.objekt && !auction.objekt) auction.objekt = detail.objekt
  if (detail.landAreaSqm != null) auction.sourceLandAreaSqm = detail.landAreaSqm
  if (detail.photoUrls.length > 0) {
    auction.photoUrls = detail.photoUrls
    auction.fotoCount = detail.photoUrls.length
  }
  if (detail.lat != null && detail.lng != null) {
    auction.lat = detail.lat
    auction.lng = detail.lng
  }
  // Append only facts not already present — enrichOne may run again on a
  // beschreibung that was carried over from an earlier snapshot.
  const newFacts = detail.facts.filter((f) => !auction.beschreibung?.includes(f))
  if (newFacts.length > 0) {
    auction.beschreibung = [auction.beschreibung, ...newFacts].filter(Boolean).join('\n')
  }
}

export const ontarioTaxSalesCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Ontario Tax Sales (Kanada)',
  baseUrl: CA_BASE,
  country: COUNTRY,
  regions: CA_REGIONS,
  crawl,
  enrichOne,
}
