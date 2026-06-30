import type { Auction, CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { ZVBAWU_BASE, COUNTRY, DE_REGIONS, BW_COURTS_FALLBACK } from './constants'
import { crawlCourt } from './list'
import { enrichInBatches, type DetailInfo } from './detail'

const PLATFORM_ID = 'zvbawu'
const REGION_NAME = 'Baden-Württemberg'

function applyDetail(auction: Auction, info: DetailInfo): void {
  auction.beschreibung = info.beschreibung
  auction.attachments = info.attachments
  auction.fotoCount = info.fotoCount
  auction.thumbnailUrl = info.thumbnailUrl
  auction.pdfUrl = info.pdfUrl
  auction.pdfUrlUpstream = info.pdfUrlUpstream
  auction.aufgehoben = info.aufgehoben
  // Detail page exposes the file number as a dedicated field; the list view
  // derives it from facts[0]. Prefer the structured value when set.
  if (info.aktenzeichen) auction.aktenzeichen = info.aktenzeichen
}

async function enrichOne(auction: Auction): Promise<void> {
  await enrichInBatches([auction], applyDetail)
}

async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  if (opts.region.toLowerCase() !== 'bw') {
    throw new Error(`zvbawü crawler does not support region ${opts.region}`)
  }
  const enrichDetails = opts.enrichDetails ?? true

  // Crawl all courts in parallel (35 small fetches → fine for one-shot).
  const courtResults = await Promise.allSettled(
    BW_COURTS_FALLBACK.map((c) => crawlCourt(c, PLATFORM_ID)),
  )

  let totalReported = 0
  const auctions = []
  for (const [i, r] of courtResults.entries()) {
    if (r.status === 'fulfilled') {
      totalReported += r.value.totalReported
      auctions.push(...r.value.auctions)
      continue
    }
    // Silent drops here have masked coverage regressions before (a single
    // court's parser breaking quietly hid 10–20% of BW from the map).
    const court = BW_COURTS_FALLBACK[i]
    const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
    console.warn(`[zvbawu] court crawl failed (${court?.slug ?? 'unknown'}): ${reason}`)
  }

  if (enrichDetails && auctions.length > 0) {
    const result = await enrichInBatches(auctions, applyDetail)
    if (result.errors > 0) {
      console.warn(
        `[zvbawu] enriched ${result.enriched}/${auctions.length}, ${result.errors} detail fetches failed`,
      )
    }
  }

  return {
    platform: PLATFORM_ID,
    source: ZVBAWU_BASE,
    countries: [COUNTRY],
    regions: [REGION_NAME],
    fetchedAt: new Date().toISOString(),
    totalReported,
    auctions,
  }
}

export const zvbawuCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'zvbawü.de (Baden-Württemberg)',
  baseUrl: ZVBAWU_BASE,
  country: COUNTRY,
  regions: DE_REGIONS,
  crawl,
  enrichOne,
}
