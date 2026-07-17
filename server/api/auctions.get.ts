import type { CrawlResult } from '~/types/auction'
import { crawlAll, crawlSingle } from '../crawlers/registry'
import { cacheKey, readVerkehrswertCache } from '../utils/verkehrswert-cache'
import { applyExtractionToAuctions, readExtractionCache } from '../utils/extraction-cache'
import { readListCache, readMergedListCache, writeListCache } from '../utils/list-cache'
import { MULTI_PLATFORM, isAllScope, isValidScopeParam, scopeParam } from '~/lib/auction-constants'

// Live-crawl fallback — only used on cold cache (startup before first refresh
// completes) or for immo=false requests which aren't cached. Short in-memory
// SWR prevents a thundering herd when the disk cache is not yet warm.
const cachedCrawl = defineCachedFunction(
  async (country: string, region: string, immobilienOnly: boolean): Promise<CrawlResult> => {
    if (isAllScope(country)) {
      return crawlAll({ immobilienOnly, enrichDetails: false })
    }
    if (isAllScope(region)) {
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
  const country = scopeParam(query.country)
  const region = scopeParam(query.region)
  if (!isValidScopeParam(country) || !isValidScopeParam(region)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid country/region' })
  }
  const immobilienOnly = query.immo !== '0'
  try {
    let result: CrawlResult | null = null

    // Serve immo=true requests from the persistent disk cache written by the
    // refresh task. immo=false falls through to the live-crawl path below.
    if (immobilienOnly) {
      if (isAllScope(country)) {
        result = await readMergedListCache()
      } else if (isAllScope(region)) {
        result = await readMergedListCache(country)
      } else {
        result = await readListCache(country, region)
      }
    }

    if (!result) {
      // Cold cache (startup), unknown region, or immo=false: live crawl.
      result = await cachedCrawl(country, region, immobilienOnly)
      // Warm the disk cache for individual regions so the next immo=true
      // request is served instantly without waiting for the refresh task.
      if (immobilienOnly && !isAllScope(country) && !isAllScope(region)) {
        writeListCache(country, region, result).catch((err: unknown) => {
          console.warn(
            `[api/auctions] list-cache write ${country}/${region}: ${(err as Error).message}`,
          )
        })
      }
    }

    // The overlays mutate the result in-place (fill nulls only) — safe for
    // both the cached and live-crawl paths.
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
        platform: MULTI_PLATFORM,
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
