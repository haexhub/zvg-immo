import { writeJsonCache } from '../json-cache'
import {
  buildTourismNutsCollection,
  isGiscoNutsFeatureCollection,
  isJsonStatResponse,
  parseJsonStatLatestValues,
  type GiscoNutsFeatureCollection,
  type TourismNutsCollection,
} from './eurostat-tourism-nuts'

// GISCO's own NUTS2json distribution (github.com/eurostat/Nuts2json, EUPL
// 1.2) — one file per NUTS level, already filtered to that level, no
// client-side LEVL_CODE filtering needed. 2024 classification, EPSG:4326,
// 1:20M generalization — small enough (a few hundred KB) to serve whole,
// unlike the ~100k-cell grid this layer sits alongside on the map.
export const GISCO_NUTS2_GEOJSON_URL =
  'https://raw.githubusercontent.com/eurostat/Nuts2json/master/pub/v2/2024/4326/20M/nutsrg_2.json'

// c_resid=TOTAL (not domestic/foreign split) and nace_r2=I551-I553 (all
// accommodation types combined, not just hotels) are pinned so the response
// carries exactly one value per (geo, time) instead of 15 candidates per
// cell — see eurostat-tourism-nuts.ts's computeOffset comment. unit=P_KM2 is
// Eurostat's own pre-computed nights-per-km² figure, so no separate
// area-normalization step is needed here.
export const EUROSTAT_TOUR_OCC_NIN2_URL =
  'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/tour_occ_nin2'
  + '?format=JSON&lang=EN&unit=P_KM2&c_resid=TOTAL&nace_r2=I551-I553'

export const EUROSTAT_TOURISM_NUTS_SOURCE_VERSION = 'eurostat-tour_occ_nin2-p_km2-gisco-nuts2024-20m'

// How far back a region's own reporting lag is allowed to reach (see
// parseJsonStatLatestValues) — wide enough to cover realistic per-country
// delay without pulling the dataset's entire multi-decade history.
const REPORT_LAG_YEARS = 3

const NUM_BINS = 6

export interface ImportEurostatTourismNutsCacheOptions {
  cachePath: string
  giscoUrl?: string
  eurostatUrl?: string
  sourceVersion?: string
  generatedAt?: string
  currentYear?: number
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface ImportEurostatTourismNutsCacheSummary {
  cachePath: string
  generatedAt: string
  sourceVersion: string
  regionCount: number
  regionsWithData: number
}

export async function importEurostatTourismNutsCache(
  options: ImportEurostatTourismNutsCacheOptions,
): Promise<ImportEurostatTourismNutsCacheSummary> {
  const fetchImpl = options.fetchImpl ?? fetch
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const sourceVersion = options.sourceVersion?.trim() || EUROSTAT_TOURISM_NUTS_SOURCE_VERSION
  const giscoUrl = options.giscoUrl?.trim() || GISCO_NUTS2_GEOJSON_URL
  const currentYear = options.currentYear ?? new Date(generatedAt).getUTCFullYear()
  const sinceYear = currentYear - REPORT_LAG_YEARS
  const eurostatUrl = `${options.eurostatUrl?.trim() || EUROSTAT_TOUR_OCC_NIN2_URL}&sinceTimePeriod=${sinceYear}`

  const gisco = await fetchGiscoNuts2Regions(fetchImpl, giscoUrl, options.signal)
  const jsonStat = await fetchJsonStat(fetchImpl, eurostatUrl, options.signal)
  const nutsIds = gisco.features.map((feature) => feature.properties.id)
  const values = parseJsonStatLatestValues(jsonStat, nutsIds)

  const collection: TourismNutsCollection = buildTourismNutsCollection(gisco, values, {
    generatedAt,
    sourceVersion,
    numBins: NUM_BINS,
  })
  await writeJsonCache(options.cachePath, collection)

  return {
    cachePath: options.cachePath,
    generatedAt,
    sourceVersion,
    regionCount: collection.regions.length,
    regionsWithData: collection.regions.filter((region) => region.value != null).length,
  }
}

async function fetchGiscoNuts2Regions(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
): Promise<GiscoNutsFeatureCollection> {
  const response = await fetchImpl(url, { signal })
  if (!response.ok) throw new Error(`GISCO NUTS2 request failed: ${response.status} ${response.statusText}`)
  const body = await response.json() as unknown
  if (!isGiscoNutsFeatureCollection(body)) throw new Error('GISCO NUTS2 response was not the expected FeatureCollection shape')
  return body
}

async function fetchJsonStat(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
) {
  const response = await fetchImpl(url, { signal })
  if (!response.ok) throw new Error(`Eurostat tour_occ_nin2 request failed: ${response.status} ${response.statusText}`)
  const body = await response.json() as unknown
  if (!isJsonStatResponse(body)) throw new Error('Eurostat tour_occ_nin2 response was not the expected JSON-stat shape')
  return body
}
