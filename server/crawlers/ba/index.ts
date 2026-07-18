import type { Auction, CrawlResult } from '~/types/auction'
import { createCrawlResult, type CrawlOptions, type PlatformCrawler } from '../types'
import { PLATFORM_ID, BA_WEB_BASE, COUNTRY, BA_REGIONS } from './constants'
import { fetchAllListings } from './list'
import { parseBamPrice, extractLocation } from './text'
import { pdfToText } from '~/server/utils/extract/pdf-text'
import { docxToText } from '~/server/utils/extract/docx-text'

async function crawl(_opts: CrawlOptions): Promise<CrawlResult> {
  const { auctions, total } = await fetchAllListings(PLATFORM_ID)
  return createCrawlResult({
    platform: PLATFORM_ID,
    source: BA_WEB_BASE,
    country: COUNTRY,
    regions: BA_REGIONS,
    totalReported: total,
    auctions,
  })
}

async function enrichOne(auction: Auction): Promise<void> {
  const applyText = (text: string | null): void => {
    if (!text) return

    if (auction.marketValue == null) {
      const price = parseBamPrice(text)
      if (price) {
        auction.marketValue = price.bam
        auction.currency = 'BAM'
        auction.marketValueText = price.text
      }
    }
    if (!auction.address) {
      const loc = extractLocation(text)
      if (loc) auction.address = loc
    }
    if (!auction.description) {
      auction.description = text.slice(0, 2000).trim()
    }
  }
  const needsMoreText = () =>
    auction.marketValue == null || !auction.address || !auction.description

  if (auction.pdfUrlUpstream) {
    applyText(await pdfToText(auction.pdfUrlUpstream))
    if (!needsMoreText()) return
  }

  // pravosudje.ba attaches most documents as DOCX rather than PDF. Try them
  // even after a PDF, because a present PDF can still be an unhelpful notice
  // while the DOCX carries the valuation/address text.
  const docxAttachments = auction.attachments.filter((a) => a.filename.toLowerCase().endsWith('.docx'))
  for (const docx of docxAttachments) {
    applyText(await docxToText(docx.proxyUrl))
    if (!needsMoreText()) return
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
