import type { Auction, CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { BOE_BASE, COUNTRY, ES_REGIONS, ES_REGION_NAMES } from './constants'
import { boeFetch, looksLikeCaptcha, markBoeCaptcha } from './fetch'
import { buildSearchUrl, buildPageUrl, extractBusquedaToken, parseListingHtml, PAGE_HITS } from './list'
import { enrichInBatches, type DetailInfo } from './detail'

type AuctionDetailFields = Pick<
  Auction,
  'verkehrswertEur' | 'verkehrswertText' | 'beschreibung' | 'adresse' | 'pdfUrl' | 'pdfUrlUpstream'
>

const PLATFORM_ID = 'boe'

async function fetchListHtml(url: string, provincia: string): Promise<string> {
  const html = await boeFetch(url)
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

export function applyDetail(auction: AuctionDetailFields, info: DetailInfo): void {
  if (info.tasacionEur != null) auction.verkehrswertEur = info.tasacionEur
  if (info.tasacionText) auction.verkehrswertText = info.tasacionText
  // Verkehrswert stays the Tasación; the minimum bid ("Valor subasta") and
  // the cadastral reference only exist on the detail tabs — surface them as
  // labelled lines in the beschreibung.
  const beschreibung = [
    info.beschreibung,
    info.valorSubastaText ? `Valor subasta: ${info.valorSubastaText}` : null,
    info.referenciaCatastral ? `Referencia catastral: ${info.referenciaCatastral}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  if (beschreibung) auction.beschreibung = beschreibung
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

async function enrichOne(auction: Auction): Promise<void> {
  const r = await enrichInBatches([auction], applyDetail)
  // Throw on failure (captcha cooldown, 5xx) so the enrich task leaves the
  // listing unstamped and retries it on a later run instead of dropping it.
  if (r.errors > 0) throw new Error('boe detail fetch failed')
}

async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const provincia = opts.region
  const enrichDetails = opts.enrichDetails ?? true

  const html = await fetchListHtml(buildSearchUrl(provincia), provincia)
  const { totalReported, auctions } = parseListingHtml(html, provincia, PLATFORM_ID)

  // page_hits=500 is the largest the form allows — a provincia with more
  // active inmuebles continues on follow-up pages addressed via the search-
  // session token embedded in the first page. Errors mid-pagination (captcha
  // cooldown, 5xx) keep the pages fetched so far instead of failing the
  // provincia outright.
  if (totalReported != null && totalReported > auctions.length) {
    const token = extractBusquedaToken(html)
    if (!token) {
      console.warn(
        `[boe] provincia ${provincia}: ${totalReported} results reported, only ${auctions.length} parsed — no pagination token found`,
      )
    } else {
      const seen = new Set(auctions.map((a) => a.zvgId))
      try {
        for (let start = PAGE_HITS; start < totalReported; start += PAGE_HITS) {
          const pageHtml = await fetchListHtml(buildPageUrl(token, start), provincia)
          const page = parseListingHtml(pageHtml, provincia, PLATFORM_ID)
          const fresh = page.auctions.filter((a) => !seen.has(a.zvgId))
          // BOE clamps an out-of-range start to the last valid page instead
          // of returning an empty one, and an expired token falls back to the
          // bare search form — either way, no new ids means we're done.
          if (fresh.length === 0) break
          for (const a of fresh) {
            seen.add(a.zvgId)
            auctions.push(a)
          }
        }
      } catch (err) {
        console.warn(
          `[boe] provincia ${provincia}: pagination stopped after ${auctions.length}/${totalReported} results: ${(err as Error).message}`,
        )
      }
    }
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
  enrichOne,
}
