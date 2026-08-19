import type { Auction, CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { ZVBAWU_BASE, COUNTRY, DE_REGIONS, BW_COURTS_FALLBACK } from './constants'
import { crawlCourt } from './list'
import { enrichInBatches, type DetailInfo } from './detail'

const PLATFORM_ID = 'zvbawu'
const REGION_NAME = 'Baden-Württemberg'

function applyDetail(auction: Auction, info: DetailInfo): void {
  auction.description = info.description
  auction.attachments = info.attachments
  auction.photoCount = info.photoCount
  auction.thumbnailUrl = info.thumbnailUrl
  auction.pdfUrl = info.pdfUrl
  auction.pdfUrlUpstream = info.pdfUrlUpstream
  auction.cancelled = info.cancelled
  // Guarded like at/biddit: a re-run whose detail payload lacks the facts must
  // not wipe values a previous run extracted (the snapshot preserves them).
  if (info.sourceLivingAreaSqm != null) auction.sourceLivingAreaSqm = info.sourceLivingAreaSqm
  if (info.sourceLandAreaSqm != null) auction.sourceLandAreaSqm = info.sourceLandAreaSqm
  if (info.sourceRooms != null) auction.sourceRooms = info.sourceRooms
  const [lat, lng] = info.latlng ?? []
  if (typeof lat === 'number' && typeof lng === 'number') {
    auction.lat = lat
    auction.lng = lng
  }
  // Detail page exposes the file number as a dedicated field; the list view
  // derives it from facts[0]. Prefer the structured value when set.
  if (info.caseNumber) auction.caseNumber = info.caseNumber
}

async function enrichOne(auction: Auction): Promise<void> {
  const r = await enrichInBatches([auction], applyDetail)
  // Aufgehobene auctions are skipped inside enrichInBatches (no error), so a
  // throw here only signals real fetch failures — the enrich task then leaves
  // the listing unstamped and retries it on a later run.
  if (r.errors > 0) throw new Error('zvbawu detail fetch failed')
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
    platformsSucceeded: [PLATFORM_ID],
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
