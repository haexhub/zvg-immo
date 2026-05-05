import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler } from '../types'
import { BOE_BASE, UA, COUNTRY, ES_REGIONS, ES_REGION_NAMES } from './constants'
import { buildSearchUrl, parseListingHtml } from './list'

const PLATFORM_ID = 'boe'

const FETCH_TIMEOUT_MS = 15_000

// BOE serves a CAPTCHA after a burst of requests from one IP. The shared
// `crawlAll` worker pool runs up to 4 regions in parallel, which would point
// every Spain crawl straight at that wall. A module-level minimum gap
// effectively serialises BOE traffic regardless of how many workers grab a
// provincia at once.
const MIN_GAP_MS = 800
let lastFetchAt = 0

async function fetchListHtml(provincia: string): Promise<string> {
  const now = Date.now()
  const wait = Math.max(0, lastFetchAt + MIN_GAP_MS - now)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastFetchAt = Date.now()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(buildSearchUrl(provincia), {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.5',
      },
    })
    if (!res.ok) throw new Error(`BOE ${res.status} for provincia ${provincia}`)
    const html = await res.text()
    // BOE shows a CAPTCHA when an IP makes too many requests in a short window
    // — the response is still 200 but the result body is the empty search form
    // wrapped around a captcha image. Detecting it lets crawlAll record the
    // failure in `errors` instead of silently returning 0 auctions.
    if (html.includes('cajaCaptcha') || html.includes('showCaptcha.php')) {
      throw new Error(`BOE returned a CAPTCHA page for provincia ${provincia} — rate limit likely`)
    }
    return html
  } finally {
    clearTimeout(timer)
  }
}

async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const provincia = opts.region

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

  // Detail enrichment (tasación, structured address, fotos) is intentionally
  // skipped for the MVP. The listing already carries enough for the map
  // (location, court, terminus, description); enrichment can be added later
  // as a per-auction GET to /detalleSubasta.php?idSub=...&ver=1 and ver=3.

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
