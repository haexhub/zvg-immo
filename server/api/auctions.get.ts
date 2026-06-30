import type { CrawlResult } from '~/types/auction'
import { crawlAll, crawlSingle } from '../crawlers/registry'
import { cacheKey, readVerkehrswertCache } from '../utils/verkehrswert-cache'
import { readExtractionCache } from '../utils/extraction-cache'

export default defineEventHandler(async (event): Promise<CrawlResult> => {
  const query = getQuery(event)
  const country = typeof query.country === 'string' ? query.country.toLowerCase() : 'all'
  const region = typeof query.region === 'string' ? query.region.toLowerCase() : 'all'
  const immobilienOnly = query.immo !== '0'
  try {
    let result: CrawlResult
    if (country === 'all') {
      // All countries, all regions. Detail enrichment off — a country-wide
      // crawl across every platform would otherwise issue thousands of
      // detail fetches and time out behind Traefik. Missing Verkehrswerte
      // (currently only AT) are filled from the disk cache populated by the
      // geocode task, see overlayCachedVerkehrswert below.
      result = await crawlAll({ immobilienOnly, enrichDetails: false })
    } else if (region === 'all') {
      // One country, all its regions. Same reasoning as above.
      result = await crawlAll({ immobilienOnly, country, enrichDetails: false })
    } else {
      result = await crawlSingle({ country, region, immobilienOnly })
    }
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
      // Don't let Nitro's SWR cache pin an empty response for the next 30 min
      // — once the upstream cooldown expires we want the very next request to
      // try BOE again, not serve stale empties.
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
  for (const a of result.auctions) {
    const hit = cache[cacheKey(a.platform, a.zvgId)]
    if (hit) a.extraction = hit
  }
}
