import type { Auction, CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import {
  AGI_BASE,
  COUNTRY,
  IT_REGIONS,
  IT_REGION_NAMES,
  PORTAL_REGION_NAMES,
} from './constants'
import { fetchSession, fetchMapData, fetchAllDetails, buildAuctions } from './list'
import { enrichInBatches, enrichSingle } from './detail'

const PLATFORM_ID = 'agi'

async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const regionCode = opts.region.toLowerCase()
  const regionName = IT_REGION_NAMES[regionCode]
  const portalRegion = PORTAL_REGION_NAMES[regionCode]
  if (!regionName || !portalRegion) {
    throw new Error(`[agi] Unbekannte Region: ${opts.region}`)
  }
  const enrichDetails = opts.enrichDetails ?? true

  const cookies = await fetchSession()
  const mapEntries = await fetchMapData(portalRegion, cookies)

  if (mapEntries.length === 0) {
    return {
      platform: PLATFORM_ID,
      platformsSucceeded: [PLATFORM_ID],
      source: AGI_BASE,
      countries: [COUNTRY],
      regions: [regionName],
      fetchedAt: new Date().toISOString(),
      totalReported: 0,
      auctions: [],
    }
  }

  const ids = mapEntries.map((e) => e.idLotto)
  const details = await fetchAllDetails(ids, cookies)
  const auctions = buildAuctions(mapEntries, details, regionName, PLATFORM_ID)

  if (enrichDetails && auctions.length > 0) {
    const result = await enrichInBatches(auctions)
    if (result.errors > 0) {
      console.warn(
        `[agi] ${regionCode}: enriched ${result.enriched}/${auctions.length}, ${result.errors} detail fetches failed`,
      )
    }
  }

  return {
    platform: PLATFORM_ID,
    platformsSucceeded: [PLATFORM_ID],
    source: AGI_BASE,
    countries: [COUNTRY],
    regions: [regionName],
    fetchedAt: new Date().toISOString(),
    totalReported: auctions.length,
    auctions,
  }
}

async function enrichOne(auction: Auction): Promise<void> {
  await enrichSingle(auction)
}

export const agiCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Aste Giudiziarie Inlinea (Italia)',
  baseUrl: AGI_BASE,
  country: COUNTRY,
  regions: IT_REGIONS,
  crawl,
  enrichOne,
}
