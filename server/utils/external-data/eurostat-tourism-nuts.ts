import { readFile } from 'node:fs/promises'

// Real annual visitor intensity per NUTS2 region, joining Eurostat's
// tour_occ_nin2 ("nights spent at tourist accommodation establishments")
// statistics with GISCO's NUTS2 boundary polygons — the map-overlay
// counterpart to lib/tourism-grid-categories.ts's OSM-derived POI-density
// grid, not a replacement for it. Unlike that grid (and unlike the
// per-auction external-data hazard adapters), this never tests a point
// against a polygon — it only ever serves whole region polygons to the map,
// so there is no geometry-matching logic here at all.

export type GeoJsonPolygonGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }

export interface GiscoNutsFeature {
  type: 'Feature'
  // GISCO's minimal redistribution only carries these two properties per
  // feature (verified live against pub/v2/2024/4326/20M/nutsrg_2.json) — no
  // CNTR_CODE/LEVL_CODE, so countryCode is derived from `id` and the NUTS
  // level is implied by which per-level file was fetched.
  properties: { id: string; na: string }
  geometry: GeoJsonPolygonGeometry
}

export interface GiscoNutsFeatureCollection {
  type: 'FeatureCollection'
  features: GiscoNutsFeature[]
}

export function isGiscoNutsFeatureCollection(input: unknown): input is GiscoNutsFeatureCollection {
  if (!input || typeof input !== 'object') return false
  const fc = input as { type?: unknown; features?: unknown }
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return false
  return fc.features.every((f) => {
    const feature = f as { properties?: { id?: unknown; na?: unknown }; geometry?: { type?: unknown } }
    return typeof feature.properties?.id === 'string'
      && typeof feature.properties?.na === 'string'
      && (feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon')
  })
}

// Minimal JSON-stat 2.0 shape — only what parseJsonStatLatestValues needs.
export interface JsonStatResponse {
  id: string[]
  size: number[]
  dimension: Record<string, { category: { index: Record<string, number> } }>
  // JSON-stat allows either representation; Eurostat's dissemination API
  // returns the sparse object form for the queries this importer makes.
  value: Record<string, number> | number[]
}

export function isJsonStatResponse(input: unknown): input is JsonStatResponse {
  if (!input || typeof input !== 'object') return false
  const r = input as { id?: unknown; size?: unknown; dimension?: unknown; value?: unknown }
  return Array.isArray(r.id) && Array.isArray(r.size) && !!r.dimension && typeof r.dimension === 'object'
    && (Array.isArray(r.value) || (!!r.value && typeof r.value === 'object'))
}

// JSON-stat's flat value index is row-major with the LAST dimension in `id`
// varying fastest — e.g. for id=['geo','time'] the layout is
// [geo0/time0, geo0/time1, ..., geo0/timeN, geo1/time0, ...]. Dimensions
// pinned to one category via the query (c_resid=TOTAL, nace_r2=I551-I553,
// unit=P_KM2, freq=A) come back with size 1, so they always contribute 0
// regardless of position — this formula doesn't need to assume geo/time are
// the only free dimensions or where they sit in `id`.
function computeOffset(id: string[], size: number[], indices: Partial<Record<string, number>>): number {
  let offset = 0
  for (let i = 0; i < id.length; i++) {
    const multiplier = size.slice(i + 1).reduce((a, b) => a * b, 1)
    offset += (indices[id[i]!] ?? 0) * multiplier
  }
  return offset
}

function readValueAt(jsonStat: JsonStatResponse, offset: number): number | null {
  const raw = Array.isArray(jsonStat.value) ? jsonStat.value[offset] : jsonStat.value[String(offset)]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

export interface TourismNutsValue {
  value: number
  /** The region's own most recent reporting year — reporting lag varies by
   *  country/NSI, so this is never assumed to match across regions. */
  dataYear: string
}

/**
 * For each requested NUTS2 id, searches its own time series backward
 * (newest year first) for the first non-null value, so a region with more
 * reporting lag than others still gets its own true latest figure instead of
 * silently inheriting a shared "current year" that it hasn't reported yet.
 * A region absent from the response's geo dimension (no data at all from
 * Eurostat) is simply left out of the returned map — the caller must not
 * drop the region itself, only its value.
 */
export function parseJsonStatLatestValues(
  jsonStat: JsonStatResponse,
  nutsIds: Iterable<string>,
): Map<string, TourismNutsValue> {
  const geoIndex = jsonStat.dimension.geo?.category.index ?? {}
  const timeIndex = jsonStat.dimension.time?.category.index ?? {}
  const yearsDesc = Object.keys(timeIndex).sort((a, b) => Number(b) - Number(a))

  const result = new Map<string, TourismNutsValue>()
  for (const nutsId of nutsIds) {
    const geoIdx = geoIndex[nutsId]
    if (geoIdx === undefined) continue
    for (const year of yearsDesc) {
      const offset = computeOffset(jsonStat.id, jsonStat.size, { geo: geoIdx, time: timeIndex[year] })
      const value = readValueAt(jsonStat, offset)
      if (value !== null) {
        result.set(nutsId, { value, dataYear: year })
        break
      }
    }
  }
  return result
}

export interface TourismNutsRegion {
  nutsId: string
  name: string
  countryCode: string
  value: number | null
  dataYear: string | null
  /** Index into the collection's `breaks` — null (not 0) when there is no
   *  Eurostat figure at all, so "no data" never renders as "very low". */
  bin: number | null
  geometry: GeoJsonPolygonGeometry
}

export interface TourismNutsCollection {
  generatedAt: string
  sourceVersion: string
  unit: 'P_KM2'
  /** Quantile break points computed from this same build's non-null values —
   *  baked in alongside `regions.*.bin` so the two can never drift apart. */
  breaks: number[]
  regions: TourismNutsRegion[]
}

// Standard linear-interpolation quantile (numpy's default 'linear' method) —
// `sorted` must already be ascending.
function quantileOf(sorted: number[], p: number): number {
  const pos = p * (sorted.length - 1)
  const lower = Math.floor(pos)
  const upper = Math.ceil(pos)
  if (lower === upper) return sorted[lower]!
  const weight = pos - lower
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight
}

/** `numBins` equal-COUNT bins (not equal-interval) — the right choice for a
 *  right-skewed distribution (a handful of high-tourism regions vastly
 *  outweighing the rest), where equal-interval edges would dump nearly every
 *  region into the lowest bin. Ties in the source data can produce duplicate
 *  break values; that's left as-is (see binIndexForValue) rather than
 *  epsilon-nudged, so two adjacent bins can end up visually empty rather than
 *  fabricating a distinction the data doesn't support. */
export function computeQuantileBreaks(values: number[], numBins: number): number[] {
  if (values.length === 0 || numBins < 2) return []
  const sorted = [...values].sort((a, b) => a - b)
  const breaks: number[] = []
  for (let i = 1; i < numBins; i++) breaks.push(quantileOf(sorted, i / numBins))
  return breaks
}

/** A value exactly on a break goes to the upper (darker) bin — one of two
 *  equally defensible conventions; this is the one this codebase uses, and
 *  the test suite pins it down explicitly. */
export function binIndexForValue(value: number, breaks: number[]): number {
  let bin = 0
  for (const b of breaks) {
    if (value < b) break
    bin++
  }
  return bin
}

export interface BuildTourismNutsCollectionOptions {
  generatedAt: string
  sourceVersion: string
  numBins: number
}

export function buildTourismNutsCollection(
  giscoFeatures: GiscoNutsFeatureCollection,
  values: Map<string, TourismNutsValue>,
  options: BuildTourismNutsCollectionOptions,
): TourismNutsCollection {
  const nonNullValues = giscoFeatures.features
    .map((feature) => values.get(feature.properties.id)?.value)
    .filter((value): value is number => value != null)
  const breaks = computeQuantileBreaks(nonNullValues, options.numBins)

  const regions: TourismNutsRegion[] = giscoFeatures.features.map((feature) => {
    const nutsId = feature.properties.id
    const entry = values.get(nutsId)
    const value = entry?.value ?? null
    return {
      nutsId,
      name: feature.properties.na,
      countryCode: nutsId.slice(0, 2),
      value,
      dataYear: entry?.dataYear ?? null,
      bin: value != null ? binIndexForValue(value, breaks) : null,
      geometry: feature.geometry,
    }
  })

  return { generatedAt: options.generatedAt, sourceVersion: options.sourceVersion, unit: 'P_KM2', breaks, regions }
}

export async function readTourismNutsCache(path: string): Promise<TourismNutsCollection> {
  const raw = await readFile(path, 'utf8')
  return JSON.parse(raw) as TourismNutsCollection
}
