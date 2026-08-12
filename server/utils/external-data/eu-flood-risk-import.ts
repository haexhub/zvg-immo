import { writeJsonCache } from '../json-cache'
import { EXTERNAL_DATA_SOURCES } from './sources'
import {
  isFeature,
  isFeatureCollection,
  normalizeFloodRiskFeatureCollection,
  type FloodRiskFeature,
  type FloodRiskFeatureCollection,
} from './eu-flood-risk'

export interface ImportEuFloodRiskCacheOptions {
  cachePath: string
  serviceUrl?: string
  sourceVersion?: string
  generatedAt?: string
  pageSize?: number
  maxPages?: number
  countryCodes?: string[]
  fetchImpl?: typeof fetch
  /** Cancels an in-flight page fetch, e.g. when /settings fires a newer
   *  trigger and runExclusiveTask aborts this run. Without it, a stalled
   *  connection to the EEA service had no bound at all. */
  signal?: AbortSignal
}

export interface ImportEuFloodRiskCacheSummary {
  cachePath: string
  serviceUrl: string
  sourceVersion: string
  generatedAt: string
  fetched: number
  normalized: number
  pages: number
}

// The EEA ArcGIS layer 500s on its own, before returning anything, once a
// page's combined geometry gets too complex to serialize — not at a fixed
// row-count threshold (verified live: a 50-row window 500s while its own two
// 25-row halves both succeed; a lower/heavier row range is fine at 150 rows).
// fetchPageWithRetry() below halves and retries a failing window instead of
// gambling on one page size for the whole dataset.
const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 10
// Bounds a single page request so a stalled connection can't leave the
// detached task's status stuck at "running" forever.
const REQUEST_TIMEOUT_MS = 30_000
// A short pause between a split page's two halves, so a retry burst doesn't
// slam a layer that already 500'd once — same total request count, less
// concurrent pressure.
const RETRY_SPLIT_DELAY_MS = 100

// The 2024 reporting cycle only holds nine countries (EE, FI, FR, HU, LV, RO,
// SE, SI, SK — verified live 2026-08-11 via returnDistinctValues) and notably
// not DE or BG, so importing it left every German auction with a bogus
// "outside, no flood risk" verdict. The 2019 cycle covers 19 countries
// including DE (548 zones), BG (77) and SE (25). Switch back once the 2024
// cycle has caught up with the countries this app actually crawls.
export const EU_FLOOD_RISK_SOURCE_VERSION = 'eea-floods-2019-riskzone-r00-2026-08-11'
export const EU_FLOOD_RISK_POLYGON_LAYER_URL =
  'https://water.discomap.eea.europa.eu/arcgis/rest/services/FloodsDirective/Floods2019_RiskZone_WM/MapServer/2'

// Full-resolution polygons are the reason this import never survived: the
// unfiltered 2024 layer measured 542 MB over the wire, ~2.5 GB peak RSS and a
// 529 MB cache file — far past the container's 2.09 GB heap limit. ArcGIS can
// generalize server-side, and at ~55 m tolerance (0.0005° in the 4326 output
// SR) the same DE+SE+BG selection is 4.9 MB with 221k instead of ~2.5M
// vertices. That is well inside the accuracy this adapter needs, which only
// distinguishes inside / within 1 km / outside.
const SIMPLIFY_TOLERANCE_DEGREES = 0.0005
// ~1 m — the coordinates arrive with 13 decimals otherwise, which is pure
// payload for a 55 m-generalized outline.
const GEOMETRY_PRECISION = 5

const FLOOD_SOURCE = EXTERNAL_DATA_SOURCES.find((source) => source.id === 'eu-flood-risk-areas')!

export async function importEuFloodRiskGeoJsonCache(
  options: ImportEuFloodRiskCacheOptions,
): Promise<ImportEuFloodRiskCacheSummary> {
  const serviceUrl = options.serviceUrl?.trim() || EU_FLOOD_RISK_POLYGON_LAYER_URL
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const sourceVersion = options.sourceVersion?.trim() || EU_FLOOD_RISK_SOURCE_VERSION
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const fetchImpl = options.fetchImpl ?? fetch
  const where = countryWhereClause(options.countryCodes)
  const features: FloodRiskFeature[] = []
  let pages = 0

  for (let offset = 0; ; offset += pageSize) {
    if (options.maxPages != null && pages >= options.maxPages) break
    const page = await fetchPageWithRetry(fetchImpl, serviceUrl, {
      where,
      offset,
      pageSize,
      signal: options.signal,
    })
    pages++
    features.push(...page.features.filter(isFeature))
    if (page.features.length < pageSize) break
  }

  const collection: FloodRiskFeatureCollection = {
    type: 'FeatureCollection',
    properties: {
      sourceVersion,
      generatedAt,
      sourceLabel: FLOOD_SOURCE.label,
      sourceUrl: FLOOD_SOURCE.sourceUrl,
      serviceUrl,
    },
    features,
  }
  const normalized = normalizeFloodRiskFeatureCollection(collection, {
    sourceVersion,
    generatedAt,
  })
  await writeJsonCache(options.cachePath, collection)

  return {
    cachePath: options.cachePath,
    serviceUrl,
    sourceVersion,
    generatedAt,
    fetched: features.length,
    normalized: normalized.zones.length,
    pages,
  }
}

/** Carries the HTTP status so fetchPageWithRetry can tell a transient
 *  server-side failure (worth splitting and retrying) apart from a request
 *  that will fail identically at any page size (bad `where` clause, bad
 *  response shape) — retrying those would just multiply the same failure. */
class ArcGisHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function fetchArcGisGeoJsonPage(
  fetchImpl: typeof fetch,
  serviceUrl: string,
  options: { where: string; offset: number; pageSize: number; signal?: AbortSignal },
): Promise<FloodRiskFeatureCollection> {
  const url = new URL(`${serviceUrl.replace(/\/$/, '')}/query`)
  url.searchParams.set('f', 'geojson')
  url.searchParams.set('where', options.where)
  url.searchParams.set('outFields', '*')
  url.searchParams.set('returnGeometry', 'true')
  url.searchParams.set('outSR', '4326')
  url.searchParams.set('maxAllowableOffset', String(SIMPLIFY_TOLERANCE_DEGREES))
  url.searchParams.set('geometryPrecision', String(GEOMETRY_PRECISION))
  url.searchParams.set('orderByFields', 'OBJECTID')
  url.searchParams.set('resultOffset', String(options.offset))
  url.searchParams.set('resultRecordCount', String(options.pageSize))

  const response = await fetchImpl(url, { signal: requestSignal(options.signal) })
  if (!response.ok) {
    throw new ArcGisHttpError(`EU flood risk request failed: ${response.status} ${response.statusText}`, response.status)
  }
  const body = await response.json() as unknown
  if (hasArcGisError(body)) {
    throw new Error(`EU flood risk request failed: ${body.error.message}`)
  }
  if (!isFeatureCollection(body)) {
    throw new Error('EU flood risk response was not a GeoJSON FeatureCollection')
  }
  return body
}

async function fetchPageWithRetry(
  fetchImpl: typeof fetch,
  serviceUrl: string,
  options: { where: string; offset: number; pageSize: number; signal?: AbortSignal },
): Promise<FloodRiskFeatureCollection> {
  try {
    return await fetchArcGisGeoJsonPage(fetchImpl, serviceUrl, options)
  } catch (err) {
    // Only a 5xx from the layer itself is the geometry-too-complex failure a
    // smaller page can work around — a bad query or malformed response fails
    // identically at any size, so splitting would just multiply the same
    // failure across many requests instead of surfacing it once.
    const isRetryable = err instanceof ArcGisHttpError && err.status >= 500
    if (!isRetryable || options.pageSize < MIN_PAGE_SIZE * 2) throw err
    const firstSize = Math.ceil(options.pageSize / 2)
    // Sequential, not Promise.all: the split was triggered by a 5xx from a
    // layer that's already struggling, and firing both halves at once only
    // adds to that pressure for the same total request count.
    const first = await fetchPageWithRetry(fetchImpl, serviceUrl, { ...options, pageSize: firstSize })
    await sleep(RETRY_SPLIT_DELAY_MS)
    const second = await fetchPageWithRetry(fetchImpl, serviceUrl, {
      where: options.where,
      offset: options.offset + firstSize,
      pageSize: options.pageSize - firstSize,
      signal: options.signal,
    })
    return { type: 'FeatureCollection', features: [...first.features, ...second.features] }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Combines the caller's cancellation (a superseded /settings trigger) with a
// per-request timeout, so a single stalled connection can't hang forever.
function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function hasArcGisError(input: unknown): input is { error: { message: string } } {
  if (!input || typeof input !== 'object') return false
  const error = (input as { error?: unknown }).error
  return !!error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
}

function countryWhereClause(countryCodes: string[] | undefined): string {
  const normalized = (countryCodes ?? [])
    .map((country) => country.trim().toUpperCase())
    .filter((country) => /^[A-Z]{2}$/.test(country))
  if (normalized.length === 0) return '1=1'
  return `countryCode IN (${normalized.map((country) => `'${country}'`).join(',')})`
}
