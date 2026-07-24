import type { Auction, CrawlResult } from '~/types/auction'
import { archiveDetailCapture } from '~/server/utils/fetch-archive'
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
  const html = await htmlFetch(auction.detailUrlUpstream)
  // CA never produces a PDF/DOCX attachment (pdfUrl/pdfUrlUpstream are always
  // null, see list.ts) — this property page is the sole source of the facts
  // below, so it's the G1 archive target here.
  await archiveDetailCapture(
    Buffer.from(html, 'utf8'),
    {
      platform: auction.platform,
      country: auction.country,
      region: auction.region,
      externalId: auction.externalId,
      caseNumber: auction.caseNumber,
      authority: auction.authority,
    },
    auction.detailUrlUpstream,
    new Date().toISOString(),
  )
  const detail = parsePropertyPage(html)

  if (detail.title && !auction.title) auction.title = detail.title
  if (detail.landAreaSqm != null) auction.sourceLandAreaSqm = detail.landAreaSqm
  if (detail.photoUrls.length > 0) {
    auction.photoUrls = detail.photoUrls
    auction.photoCount = detail.photoUrls.length
  }
  if (detail.lat != null && detail.lng != null) {
    auction.lat = detail.lat
    auction.lng = detail.lng
  }
  // Append only facts not already present — enrichOne may run again on a
  // description that was carried over from an earlier snapshot.
  const newFacts = detail.facts.filter((f) => !auction.description?.includes(f))
  if (newFacts.length > 0) {
    auction.description = [auction.description, ...newFacts].filter(Boolean).join('\n')
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
