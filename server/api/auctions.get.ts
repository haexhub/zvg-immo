import type { CrawlResult } from '~/types/auction'
import { crawlAll, crawlSingle } from '../crawlers/registry'
import { cacheKey, readVerkehrswertCache } from '../utils/verkehrswert-cache'
import { applyExtractionToAuctions, readExtractionCache } from '../utils/extraction-cache'

// Caching lives here (defineCachedFunction) instead of an SWR route rule:
// Nitro's route-rule cache stores the handler response regardless of any
// cache-control header the handler sets, so the graceful empty result below
// used to get pinned for the full SWR window. cachedFunction only persists
// successful results — a rate-limited crawl throws, is caught below, and the
// very next request retries the upstream.
const cachedCrawl = defineCachedFunction(
  async (country: string, region: string, immobilienOnly: boolean): Promise<CrawlResult> => {
    if (country === 'all') {
      // All countries, all regions. Detail enrichment off — a country-wide
      // crawl across every platform would otherwise issue thousands of
      // detail fetches and time out behind Traefik. Missing Verkehrswerte
      // (currently only AT) are filled from the disk cache populated by the
      // geocode task, see overlayCachedVerkehrswert below.
      return crawlAll({ immobilienOnly, enrichDetails: false })
    }
    if (region === 'all') {
      // One country, all its regions. Same reasoning as above.
      return crawlAll({ immobilienOnly, country, enrichDetails: false })
    }
    return crawlSingle({ country, region, immobilienOnly })
  },
  {
    name: 'auctions-crawl',
    maxAge: 1800,
    swr: true,
    getKey: (country, region, immobilienOnly) =>
      `${country}:${region}:${immobilienOnly ? '1' : '0'}`,
  },
)

export default defineEventHandler(async (event): Promise<CrawlResult> => {
  const query = getQuery(event)
  const country = typeof query.country === 'string' ? query.country.toLowerCase() : 'all'
  const region = typeof query.region === 'string' ? query.region.toLowerCase() : 'all'
  const immobilienOnly = query.immo !== '0'
  try {
    const result = await cachedCrawl(country, region, immobilienOnly)
    // The overlays mutate the cached object; that's safe (they only fill
    // nulls, synchronously) and wanted — newly cached Verkehrswerte and
    // extractions show up without waiting for the crawl cache to expire.
    await overlayCachedVerkehrswert(result)
    await overlayExtraction(result)
    return result
  } catch (err) {
    // Normalize: thrown values aren't guaranteed to be Errors.
    const msg =
      typeof err === 'string'
        ? err
        : err instanceof Error
          ? err.message
          : String(err)
    // Upstream rate-limit responses (BOE's captcha page or an HTTP 429) are
    // temporary and self-clear within minutes. Surfacing them as 502 makes
    // the whole map view break for that provincia, including the geocoding
    // data we already have. Degrade gracefully: log server-side, return an
    // empty result so the rest of the UI keeps working.
    const lower = msg.toLowerCase()
    const rateLimited =
      lower.includes('captcha') || lower.includes('rate limit') || /\b429\b/.test(msg)
    if (rateLimited) {
      console.warn(`[api/auctions] ${country}/${region} rate-limited: ${msg}`)
      // Not cached: cachedCrawl above only stores successful results, and this
      // header keeps browsers/proxies from holding on to the empty response.
      setResponseHeader(event, 'cache-control', 'no-store, max-age=0')
      return {
        platform: 'multi',
        source: '',
        countries: [country],
        regions: [region],
        fetchedAt: new Date().toISOString(),
        totalReported: null,
        auctions: [],
      }
    }
    throw createError({
      statusCode: 502,
      statusMessage: 'Crawler-Quelle nicht erreichbar',
      data: { detail: msg },
    })
  }
})

async function overlayCachedVerkehrswert(result: CrawlResult): Promise<void> {
  const needsOverlay = result.auctions.some((a) => a.verkehrswertEur == null)
  if (!needsOverlay) return
  const cache = await readVerkehrswertCache()
  for (const a of result.auctions) {
    if (a.verkehrswertEur != null) continue
    const hit = cache[cacheKey(a.platform, a.zvgId)]
    if (!hit) continue
    a.verkehrswertEur = hit.verkehrswertEur
    a.verkehrswertText = hit.verkehrswertText
  }
}

// Decorate auctions with the structured fields (property type + sizes) produced
// by the enrich task. Read-only, like the Verkehrswert overlay: a cache miss
// just leaves `extraction` undefined.
async function overlayExtraction(result: CrawlResult): Promise<void> {
  const cache = await readExtractionCache()
  if (Object.keys(cache).length === 0) return
  applyExtractionToAuctions(result.auctions, cache)
}
