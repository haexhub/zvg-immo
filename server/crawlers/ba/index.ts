import type { Auction, CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { PLATFORM_ID, BA_WEB_BASE, COUNTRY, BA_REGIONS } from './constants'
import { fetchAllListings } from './list'
import { parseBamPrice, extractLocation } from './text'
import { pdfToText } from '~/server/utils/extract/pdf-text'
import { docxToText } from '~/server/utils/extract/docx-text'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return {
    platform: PLATFORM_ID,
    source: BA_WEB_BASE,
    countries: [COUNTRY],
    regions: BA_REGIONS.map((r) => r.name),
    fetchedAt: new Date().toISOString(),
    totalReported: total,
    auctions,
  }
}

async function enrichOne(auction: Auction): Promise<void> {
  // pravosudje.ba attaches 42/49 documents as DOCX rather than PDF; fall back
  // to extracting from the DOCX attachment when there's no PDF.
  const docx = auction.attachments.find((a) => a.filename.toLowerCase().endsWith('.docx'))
  const text = auction.pdfUrlUpstream
    ? await pdfToText(auction.pdfUrlUpstream)
    : docx
      ? await docxToText(docx.proxyUrl)
      : null
  if (!text) return

  if (!auction.verkehrswertEur) {
    const price = parseBamPrice(text)
    if (price) {
      auction.verkehrswertEur = price.eur
      auction.verkehrswertText = price.text
    }
  }
  if (!auction.adresse) {
    const loc = extractLocation(text)
    if (loc) auction.adresse = loc
  }
  if (!auction.beschreibung) {
    auction.beschreibung = text.slice(0, 2000).trim()
  }
}

export const pravosudijeCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Portal pravosuđa BiH (Bosnien-Herzegowina)',
  baseUrl: BA_WEB_BASE,
  country: COUNTRY,
  regions: BA_REGIONS,
  crawl,
  enrichOne,
}
