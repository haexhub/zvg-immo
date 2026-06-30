import type { Auction, CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { BOE_BASE, COUNTRY, ES_REGIONS, ES_REGION_NAMES } from './constants'
import { boeFetch, looksLikeCaptcha, markBoeCaptcha } from './fetch'
import { buildSearchUrl, parseListingHtml } from './list'
import { enrichInBatches, type DetailInfo } from './detail'

type AuctionDetailFields = Pick<
  Auction,
  'verkehrswertEur' | 'verkehrswertText' | 'beschreibung' | 'adresse' | 'pdfUrl' | 'pdfUrlUpstream'
>

const PLATFORM_ID = 'boe'

async function fetchListHtml(provincia: string): Promise<string> {
  const html = await boeFetch(buildSearchUrl(provincia))
  // BOE shows a CAPTCHA when an IP makes too many requests in a short window
  // — the response is still 200 but the result body is the empty search form
  // wrapped around a captcha image. Detecting it lets crawlAll record the
  // failure in `errors` instead of silently returning 0 auctions.
  if (looksLikeCaptcha(html)) {
    console.warn(
      `[boe] CAPTCHA on listing for provincia ${provincia} at ${new Date().toISOString()} — arming 24h cooldown`,
    )
    await markBoeCaptcha()
    throw new Error(`BOE returned a CAPTCHA page for provincia ${provincia} — rate limit likely`)
  }
  return html
}

function applyDetail(auction: AuctionDetailFields, info: DetailInfo): void {
  if (info.tasacionEur != null) auction.verkehrswertEur = info.tasacionEur
  if (info.tasacionText) auction.verkehrswertText = info.tasacionText
  if (info.beschreibung) auction.beschreibung = info.beschreibung
  // ver=3 has the structured address; trust it over the listing's best-effort.
  if (info.adresse) auction.adresse = info.adresse
  // Construct the official BOE-Boletín document URL from its id. Only
  // extract the canonical `BOE-B-yyyy-N+` shape so noisy upstream text can
  // never produce a malformed pdfUrl.
  const boeId = info.anuncioBoeId?.match(/\bBOE-B-\d{4}-\d+\b/)?.[0]
  if (boeId) {
    auction.pdfUrlUpstream = `https://www.boe.es/diario_boe/txt.php?id=${encodeURIComponent(boeId)}`
    auction.pdfUrl = auction.pdfUrlUpstream
  }
}

async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const provincia = opts.region
  const enrichDetails = opts.enrichDetails ?? true

  const html = await fetchListHtml(provincia)
  const { totalReported, auctions } = parseListingHtml(html, provincia, PLATFORM_ID)

  // page_hits=500 is the largest the form allows. A provincia with more than
  // 500 active inmuebles would silently lose the tail. Pagination is not
  // implemented yet — log loudly so we notice in production telemetry, and
  // ship the partial set so the rest of the crawl still succeeds.
  if (totalReported != null && totalReported > auctions.length) {
    console.warn(
      `[boe] provincia ${provincia}: ${totalReported} results reported, only ${auctions.length} parsed — pagination NYI`,
    )
  }

  if (enrichDetails && auctions.length > 0) {
    const result = await enrichInBatches(auctions, applyDetail)
    if (result.errors > 0) {
      console.warn(
        `[boe] provincia ${provincia}: enriched ${result.enriched}/${auctions.length}, ${result.errors} detail fetches failed`,
      )
    }
  }

  return {
    platform: PLATFORM_ID,
    source: BOE_BASE,
    countries: [COUNTRY],
    regions: [ES_REGION_NAMES[provincia] || provincia],
    fetchedAt: new Date().toISOString(),
    totalReported,
    auctions,
  }
}

export const boeCrawler: PlatformCrawler = {
  id: PLATFORM_ID,
  name: 'Portal de Subastas (Agencia Estatal BOE)',
  baseUrl: BOE_BASE,
  country: COUNTRY,
  regions: ES_REGIONS,
  crawl,
}
