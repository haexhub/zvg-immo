import type { Auction, CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { BE_REGIONS, BIDDIT_BASE, COUNTRY, REGION_NAME } from './constants'
import { fetchAllPublicSales } from './list'
import { enrichInBatches, type DetailInfo } from './detail'
import { fetchOrganisationNames } from './organisation'

const PLATFORM_ID = 'biddit'

type AuctionDetailFields = Pick<
  Auction,
  | 'verkehrswertEur'
  | 'verkehrswertText'
  | 'beschreibung'
  | 'adresse'
  | 'attachments'
  | 'pdfUrl'
  | 'pdfUrlUpstream'
  | 'fotoCount'
  | 'thumbnailUrl'
  | 'aufgehoben'
>

function applyDetail(auction: AuctionDetailFields, info: DetailInfo): void {
  if (info.estimatedPrice != null) {
    auction.verkehrswertEur = info.estimatedPrice
    auction.verkehrswertText = `${info.estimatedPrice.toLocaleString('de-DE')} €`
  }
  if (info.beschreibung) auction.beschreibung = info.beschreibung
  if (info.adresse) auction.adresse = info.adresse
  if (info.attachments.length > 0) auction.attachments = info.attachments
  if (info.pdfUrl) {
    auction.pdfUrl = info.pdfUrl
    auction.pdfUrlUpstream = info.pdfUrlUpstream
  }
  if (info.fotoCount > 0) auction.fotoCount = info.fotoCount
  if (info.thumbnailUrl) auction.thumbnailUrl = info.thumbnailUrl
  // Listing already sets aufgehoben from `withdrawn`; the detail endpoint
  // may flip it between fetch and enrich (notary withdraws mid-crawl).
  if (info.aufgehoben) auction.aufgehoben = true
}

async function enrichOne(auction: Auction): Promise<void> {
  await enrichInBatches([auction], applyDetail)
}

async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  if (opts.region.toLowerCase() !== 'all') {
    throw new Error(`biddit crawler does not support region ${opts.region}`)
  }
  const enrichDetails = opts.enrichDetails ?? true

  const { totalReported, auctions: mapped } = await fetchAllPublicSales(PLATFORM_ID)
  const auctions = mapped.map((m) => m.auction)

  // Resolve notary names so `amtsgericht` carries the office label instead
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
      if (name) item.amtsgericht = name
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
