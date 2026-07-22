import type { Auction, CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { BE_REGIONS, BIDDIT_BASE, COUNTRY, REGION_NAME } from './constants'
import { fetchAllPublicSales } from './list'
import { enrichInBatches, formatVerkehrswertText, type DetailInfo } from './detail'
import { fetchOrganisationNames } from './organisation'

const PLATFORM_ID = 'biddit'

type AuctionDetailFields = Pick<
  Auction,
  | 'marketValueEur'
  | 'marketValueText'
  | 'startingBid'
  | 'description'
  | 'address'
  | 'attachments'
  | 'pdfUrl'
  | 'pdfUrlUpstream'
  | 'photoCount'
  | 'thumbnailUrl'
  | 'cancelled'
  | 'lat'
  | 'lng'
  | 'sourceLivingAreaSqm'
  | 'sourceLandAreaSqm'
>

export function applyDetail(auction: AuctionDetailFields, info: DetailInfo): void {
  if (info.estimatedPrice != null) {
    auction.marketValueEur = info.estimatedPrice
    auction.marketValueText = formatVerkehrswertText(info)
  }
  // Detail-level startingPrice is the same Mindestgebot the listing already
  // carries, just refetched — only overwrite when it's actually present so a
  // transient detail hiccup can't null out a good list-level startingBid.
  if (info.startingPrice != null) auction.startingBid = info.startingPrice
  if (info.description) auction.description = info.description
  if (info.address) auction.address = info.address
  if (info.attachments.length > 0) auction.attachments = info.attachments
  if (info.pdfUrl) {
    auction.pdfUrl = info.pdfUrl
    auction.pdfUrlUpstream = info.pdfUrlUpstream
  }
  auction.photoCount = info.photoCount
  if (info.thumbnailUrl) auction.thumbnailUrl = info.thumbnailUrl
  if (info.lat != null && info.lng != null) {
    auction.lat = info.lat
    auction.lng = info.lng
  }
  if (info.sourceLivingAreaSqm != null) auction.sourceLivingAreaSqm = info.sourceLivingAreaSqm
  if (info.sourceLandAreaSqm != null) auction.sourceLandAreaSqm = info.sourceLandAreaSqm
  // Listing already sets cancelled from `withdrawn`; the detail endpoint
  // may flip it between fetch and enrich (notary withdraws mid-crawl).
  if (info.cancelled) auction.cancelled = true
}

async function enrichOne(auction: Auction): Promise<void> {
  const r = await enrichInBatches([auction], applyDetail)
  // A vanished lot (detail API 404) yields no error — permanent, stamp it.
  // Real fetch failures must throw so the enrich task retries later.
  if (r.errors > 0) throw new Error('biddit detail fetch failed')
}

async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  if (opts.region.toLowerCase() !== 'all') {
    throw new Error(`biddit crawler does not support region ${opts.region}`)
  }
  const enrichDetails = opts.enrichDetails ?? true

  const { totalReported, auctions: mapped } = await fetchAllPublicSales(PLATFORM_ID)
  const auctions = mapped.map((m) => m.auction)

  // Resolve notary names so `authority` carries the office label instead
  // of the bare reference number. Cheap — there's usually <50 unique
  // organisations across the ~370 active lots.
  const orgIds = mapped
    .map((m) => m.organisationId)
    .filter((s): s is string => Boolean(s))
  if (orgIds.length > 0) {
    const names = await fetchOrganisationNames(orgIds)
    for (const [i, m] of mapped.entries()) {
      const item = auctions[i]
      if (!item || !m.organisationId) continue
      const name = names.get(m.organisationId)
      if (name) item.authority = name
    }
  }

  if (enrichDetails && auctions.length > 0) {
    const result = await enrichInBatches(auctions, applyDetail)
    if (result.errors > 0) {
      console.warn(
        `[biddit] enriched ${result.enriched}/${auctions.length}, ${result.errors} detail fetches failed`,
      )
    }
  }

  return {
    platform: PLATFORM_ID,
    source: BIDDIT_BASE,
    countries: [COUNTRY],
    regions: [REGION_NAME],
    fetchedAt: new Date().toISOString(),
    totalReported,
    auctions,
  }
}

export const bidditCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Biddit (Notariat Belgien)',
  baseUrl: BIDDIT_BASE,
  country: COUNTRY,
  regions: BE_REGIONS,
  crawl,
  enrichOne,
}
