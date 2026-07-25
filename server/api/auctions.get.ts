import type { CrawlResult } from '~/types/auction'
import {
  crawlAll,
  crawlSingle,
  ensureEnabledCountriesLoaded,
  getEnabledCountryCodes,
  isCountryEnabled,
} from '../crawlers/registry'
import { cacheKey, readVerkehrswertCache } from '../utils/verkehrswert-cache'
import { applyExtractionToAuctions, readExtractionCache } from '../utils/extraction-cache'
import { applySnapshotPhotosToAuctions, readAuctionSnapshot } from '../utils/auction-snapshot'
import { readListCache, readMergedListCache, writeListCache } from '../utils/list-cache'
import { MULTI_PLATFORM, isAllScope, isValidScopeParam, scopeParam } from '~/lib/auction-constants'
import { applyDescriptionMarketValue } from '../utils/description-market-value'

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
      `${getEnabledCountryCodes().sort().join(',')}:${country}:${region}:${immobilienOnly ? '1' : '0'}`,
  },
)

export default defineEventHandler(async (event): Promise<CrawlResult> => {
  await ensureEnabledCountriesLoaded()
  const query = getQuery(event)
  const country = scopeParam(query.country)
  const region = scopeParam(query.region)
  if (!isValidScopeParam(country) || !isValidScopeParam(region)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid country/region' })
  }
  const immobilienOnly = query.immo !== '0'
  // Paused country requested directly (permalink, saved search, hand-typed URL):
  // return an empty result instead of live-crawling it via the fallback below.
  // The 'all' scope stays allowed — it only aggregates enabled countries.
  if (!isAllScope(country) && !isCountryEnabled(country)) {
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
    // both the cached and live-crawl paths. Snapshot photos run before the
    // extraction overlay so a native photo (Foto.pdf render, gallery URL)
    // takes priority over PDF-mined photos, matching the enrich task's own
    // preference order (see server/tasks/enrich.ts's photo pipeline).
    await overlayCachedVerkehrswert(result)
    await overlaySnapshotPhotos(result)
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
  const needsOverlay = result.auctions.some((a) => a.marketValueEur == null)
  if (!needsOverlay) return
  const [cache, snapshot] = await Promise.all([
    readVerkehrswertCache(),
    readAuctionSnapshot(),
  ])
  for (const a of result.auctions) {
    if (a.marketValueEur != null) continue
    const hit = cache[cacheKey(a.platform, a.externalId)]
    if (hit?.marketValueEur != null) {
      a.marketValueEur = hit.marketValueEur
      a.marketValueText = hit.marketValueText
      continue
    }
    const snapshotHit = snapshot[cacheKey(a.platform, a.externalId)]
    if (!snapshotHit) continue
    const candidate = { ...snapshotHit }
    applyDescriptionMarketValue(candidate)
    if (candidate.marketValueEur == null) continue
    a.marketValueEur = candidate.marketValueEur
    a.marketValueText = candidate.marketValueText
  }
}

// Decorate list-crawl auctions with the thumbnailUrl/photoCount/photoUrls the
// enrich task's detail fetch found and persisted to auction_snapshot — the
// list crawl itself never carries these for platforms whose photos only
// surface on the detail page (e.g. zvg-portal's Foto.pdf render, see
// crawlers/zvg-portal/list.ts vs. index.ts's applyDetail). Read-only, like the
// Verkehrswert overlay: a cache miss just leaves the list-crawl value in place.
async function overlaySnapshotPhotos(result: CrawlResult): Promise<void> {
  const snapshot = await readAuctionSnapshot()
  applySnapshotPhotosToAuctions(result.auctions, snapshot)
}

// Decorate auctions with the structured fields (property type + sizes) produced
// by the enrich task. Read-only, like the Verkehrswert overlay: a cache miss
// just leaves `extraction` undefined.
async function overlayExtraction(result: CrawlResult): Promise<void> {
  const cache = await readExtractionCache()
  if (Object.keys(cache).length === 0) return
  applyExtractionToAuctions(result.auctions, cache)
}
