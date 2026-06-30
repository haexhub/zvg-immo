import type { Auction, CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { AT_BASE, AT_REGIONS, AT_REGION_NAMES, COUNTRY } from './constants'
import { buildSearchUrl, fetchListHtml, parseListingHtml } from './list'
import { enrichInBatches, type DetailInfo } from './detail'

const PLATFORM_ID = 'at-edikte'

/** 18 months forward — covers every announced auction comfortably while
 *  staying well under the portal's `SearchMax=4999`. */
const RANGE_MONTHS_FORWARD = 18

type AuctionDetailFields = Pick<
  Auction,
  | 'aktenzeichen'
  | 'amtsgericht'
  | 'adresse'
  | 'verkehrswertEur'
  | 'verkehrswertText'
  | 'beschreibung'
  | 'attachments'
  | 'pdfUrl'
  | 'pdfUrlUpstream'
  | 'fotoCount'
  | 'thumbnailUrl'
>

function applyDetail(auction: AuctionDetailFields, info: DetailInfo): void {
  if (info.aktenzeichen) auction.aktenzeichen = info.aktenzeichen
  if (info.amtsgericht) auction.amtsgericht = info.amtsgericht
  if (info.adresse) auction.adresse = info.adresse
  if (info.schaetzwertEur != null) auction.verkehrswertEur = info.schaetzwertEur
  if (info.schaetzwertText) auction.verkehrswertText = info.schaetzwertText
  if (info.beschreibung) auction.beschreibung = info.beschreibung
  if (info.attachments.length > 0) auction.attachments = info.attachments
  if (info.pdfUrl) {
    auction.pdfUrl = info.pdfUrl
    auction.pdfUrlUpstream = info.pdfUrlUpstream
  }
  if (info.fotoCount > 0) auction.fotoCount = info.fotoCount
  if (info.thumbnailUrl) auction.thumbnailUrl = info.thumbnailUrl
}

async function enrichOne(auction: Auction): Promise<void> {
  await enrichInBatches([auction], applyDetail)
}

async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const regionCode = opts.region.toLowerCase()
  const regionName = AT_REGION_NAMES[regionCode]
  if (!regionName) {
    throw new Error(`AT crawler does not support region ${opts.region}`)
  }
  const enrichDetails = opts.enrichDetails ?? true

  const now = new Date()
  const dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dateTo = new Date(now.getFullYear(), now.getMonth() + RANGE_MONTHS_FORWARD, now.getDate())

  const url = buildSearchUrl(regionCode, dateFrom, dateTo)
  const html = await fetchListHtml(url)
  const { totalReported, auctions } = parseListingHtml(html, regionCode, PLATFORM_ID)

  if (enrichDetails && auctions.length > 0) {
    const result = await enrichInBatches(auctions, applyDetail)
    if (result.errors > 0) {
      console.warn(
        `[at-edikte] ${regionCode}: enriched ${result.enriched}/${auctions.length}, ${result.errors} detail fetches failed`,
      )
    }
  }

  return {
    platform: PLATFORM_ID,
    source: AT_BASE,
    countries: [COUNTRY],
    regions: [regionName],
    fetchedAt: new Date().toISOString(),
    totalReported,
    auctions,
  }
}

export const atEdikteCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Ediktsdatei (Justiz Österreich)',
  baseUrl: AT_BASE,
  country: COUNTRY,
  regions: AT_REGIONS,
  crawl,
  enrichOne,
}
