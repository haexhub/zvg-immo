// Copernicus EFFIS wildfire hazard adapter — JRC MODIS Burnt Area polygons
// (2016–present), the one EFFIS layer that survived live verification.
//
// Two other EFFIS layers were investigated and rejected before this one:
// - mf010.query (MeteoFrance Fire Weather Index forecast, the "current fire
//   danger" layer the plan called for): WMS GetFeatureInfo against it, tried
//   with text/plain, text/html and GML info formats across several European
//   points and dates (Stockholm, Marseille, Athens; 2022–2026), consistently
//   returned either an empty body or an unfilled HTML template
//   ([FWI]/[DANGER_RISK] placeholders never substituted) — never a resolved
//   value. Treated as unverified rather than shipped as a feature that would
//   silently render `unknown` everywhere.
// - The service's WFS also 502s on `outputformat=json`/`application/json`
//   for every typename tried; only GML3 output works.
// So there is currently no verified "current fire danger" signal from EFFIS —
// only this historical burnt-area record, which is itself a static/slowly-
// changing signal (new fire seasons are added roughly annually), not the
// short-TTL forecast the plan envisioned. That gap is intentional, tracked in
// docs/plans/2026-07-26-eu-market-risk-data-sources-plan.md, not an oversight.
//
// Verified live 2026-07-29 against https://maps.effis.emergency.copernicus.eu/effis:
// - WFS 1.1.0 GetFeature, typename=modis.ba.poly, outputformat=GML3: 200,
//   real polygons with FIREDATE/COUNTRY/AREA_HA attributes.
// - BBOX axis order follows the declared CRS (EPSG:4326 → lat,lng; CRS84 →
//   lng,lat) — this adapter uses CRS84 to match the lng,lat convention the
//   rest of this module (and GeoJsonPosition) already uses.
// - CQL_FILTER is accepted but silently ignored by this MapServer instance
//   (a country filter returned other countries too) — only BBOX actually
//   scopes results, confirmed by comparing feature counts/countries returned.

import { readFile } from 'node:fs/promises'
import * as cheerio from 'cheerio'
import type { Auction, HazardAssessment } from '~/types/auction'
import type { HazardAssessmentAdapter } from '~/server/tasks/external-enrichment'
import { writeJsonCache } from '../json-cache'
import {
  distanceToPolygonMeters,
  pointInPolygon,
  type GeoJsonLinearRing,
  type GeoJsonPolygonCoordinates,
} from './eu-flood-risk'
import { EXTERNAL_DATA_SOURCES } from './sources'

export interface BurntAreaZone {
  id: string
  polygon: GeoJsonPolygonCoordinates
  fireDate: string | null
  country: string | null
  areaHa: number | null
}

export interface BurntAreaCollection {
  sourceVersion: string
  generatedAt: string
  zones: BurntAreaZone[]
}

export interface BurntAreaEvaluationOptions {
  nearbyDistanceMeters?: number
  checkedAt?: string
  maxCacheAgeDays?: number
}

export interface BurntAreaFileAdapterOptions extends BurntAreaEvaluationOptions {
  cachePath: string
  sourceVersion?: string
}

export interface ImportCopernicusEffisCacheOptions {
  cachePath: string
  serviceUrl?: string
  sourceVersion?: string
  generatedAt?: string
  /** [minLng, minLat, maxLng, maxLat], CRS84. Defaults to EFFIS's own
   *  Europe/Mediterranean coverage extent. */
  bbox?: [number, number, number, number]
  pageSize?: number
  maxPages?: number
  fetchImpl?: typeof fetch
}

export interface ImportCopernicusEffisCacheSummary {
  cachePath: string
  serviceUrl: string
  sourceVersion: string
  generatedAt: string
  fetched: number
  normalized: number
  pages: number
}

const DEFAULT_NEARBY_DISTANCE_METERS = 2_000
const DEFAULT_PAGE_SIZE = 1_000
// Matches the coverage extent EFFIS itself declares for its European fire
// layers (mf010.query's LatLonBoundingBox) — wide enough for every currently
// active crawler country.
const DEFAULT_BBOX: [number, number, number, number] = [-25, 25, 50, 72]
export const COPERNICUS_EFFIS_SOURCE_VERSION = 'jrc-modis-ba-poly-2026-07-29'
export const COPERNICUS_EFFIS_WFS_URL = 'https://maps.effis.emergency.copernicus.eu/effis'
const EFFIS_SOURCE = EXTERNAL_DATA_SOURCES.find((source) => source.id === 'copernicus-effis')!
// EFFIS's own "Forest Fires in Europe" annual reports define a "large fire"
// as one burning more than 500 ha — the only publicly documented severity
// boundary for this dataset, so severity reuses that threshold rather than
// an invented scale. Below the medium threshold, or when AREA_HA is missing,
// severity is 'unknown' rather than guessed.
const LARGE_FIRE_HA = 500
const MEDIUM_FIRE_HA = 50

export async function readBurntAreaCache(path: string, sourceVersion?: string): Promise<BurntAreaCollection> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as BurntAreaCollection
  return { ...raw, sourceVersion: sourceVersion ?? raw.sourceVersion }
}

/** Parses a WFS GetFeature GML3 response for modis.ba.poly into normalized
 *  zones. Cheerio in xmlMode keeps namespace prefixes as literal tag-name
 *  text (`gml:featureMember`, not `featureMember`), so every selector below
 *  matches on the prefixed name. Only single-ring `gml:Polygon` geometries
 *  are handled — every feature observed in this dataset uses one; a feature
 *  without a parseable posList is skipped rather than guessed at. */
export function parseBurntAreaGml(xml: string): BurntAreaZone[] {
  const $ = cheerio.load(xml, { xmlMode: true })
  const zones: BurntAreaZone[] = []
  $('gml\\:featureMember').each((index, el) => {
    const feature = $(el).children().first()
    const ring = ringFromPosList(feature.find('gml\\:posList').first().text())
    if (!ring) return
    const areaHaRaw = feature.find('ms\\:AREA_HA').first().text().trim()
    const areaHa = areaHaRaw ? Number(areaHaRaw) : null
    zones.push({
      id: feature.attr('gml:id') || `modis-ba-poly-${index + 1}`,
      polygon: [ring],
      fireDate: textOrNull(feature.find('ms\\:FIREDATE').first().text()),
      country: textOrNull(feature.find('ms\\:COUNTRY').first().text()),
      areaHa: areaHa != null && Number.isFinite(areaHa) ? areaHa : null,
    })
  })
  return zones
}

export async function importCopernicusEffisBurntAreaCache(
  options: ImportCopernicusEffisCacheOptions,
): Promise<ImportCopernicusEffisCacheSummary> {
  const serviceUrl = options.serviceUrl?.trim() || COPERNICUS_EFFIS_WFS_URL
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const sourceVersion = options.sourceVersion?.trim() || COPERNICUS_EFFIS_SOURCE_VERSION
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const bbox = options.bbox ?? DEFAULT_BBOX
  const fetchImpl = options.fetchImpl ?? fetch
  const zones: BurntAreaZone[] = []
  let fetched = 0
  let pages = 0

  for (let startIndex = 0; ; startIndex += pageSize) {
    if (options.maxPages != null && pages >= options.maxPages) break
    const gml = await fetchBurntAreaGmlPage(fetchImpl, serviceUrl, { bbox, startIndex, pageSize })
    pages++
    const pageZones = parseBurntAreaGml(gml)
    fetched += pageZones.length
    zones.push(...pageZones)
    if (pageZones.length < pageSize) break
  }

  const collection: BurntAreaCollection = { sourceVersion, generatedAt, zones }
  await writeJsonCache(options.cachePath, collection)

  return {
    cachePath: options.cachePath,
    serviceUrl,
    sourceVersion,
    generatedAt,
    fetched,
    normalized: zones.length,
    pages,
  }
}

export function buildWildfireHazardAssessment(
  auction: Auction,
  collection: BurntAreaCollection,
  options: BurntAreaEvaluationOptions = {},
): HazardAssessment | null {
  if (auction.lat == null || auction.lng == null) return null
  const checkedAt = options.checkedAt ?? new Date().toISOString()
  const nearbyDistanceMeters = options.nearbyDistanceMeters ?? DEFAULT_NEARBY_DISTANCE_METERS
  const point = { lat: auction.lat, lng: auction.lng }

  if (isStale(collection.generatedAt, checkedAt, options.maxCacheAgeDays)) {
    return assessment('unknown', 'unknown', null, checkedAt, true)
  }

  if (collection.zones.length === 0) {
    return assessment('unknown', 'unknown', null, checkedAt)
  }

  const matches = collection.zones
    .map((zone) => ({
      zone,
      inside: pointInPolygon(point, zone.polygon),
      distanceMeters: distanceToPolygonMeters(point, zone.polygon),
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)

  const inside = matches.find((match) => match.inside)
  if (inside) {
    return assessment('inside', severityForZone(inside.zone), 0, checkedAt)
  }

  const nearest = matches[0]
  if (!nearest || !Number.isFinite(nearest.distanceMeters)) {
    return assessment('unknown', 'unknown', null, checkedAt)
  }

  if (nearest.distanceMeters <= nearbyDistanceMeters) {
    return assessment('nearby', severityForZone(nearest.zone), nearest.distanceMeters, checkedAt)
  }

  return assessment('outside', 'unknown', nearest.distanceMeters, checkedAt)
}

export async function createCopernicusEffisBurntAreaFileAdapter(
  options: BurntAreaFileAdapterOptions,
): Promise<HazardAssessmentAdapter> {
  const collection = await readBurntAreaCache(options.cachePath, options.sourceVersion)
  return {
    id: 'copernicus-effis-burnt-area-file-cache',
    sourceVersion: options.sourceVersion ?? collection.sourceVersion,
    supports: (auction) => auction.lat != null && auction.lng != null,
    async assess(auction) {
      const result = buildWildfireHazardAssessment(auction, collection, options)
      return result ? [result] : []
    },
  }
}

function severityForZone(zone: BurntAreaZone): HazardAssessment['severity'] {
  if (zone.areaHa == null) return 'unknown'
  if (zone.areaHa >= LARGE_FIRE_HA) return 'high'
  if (zone.areaHa >= MEDIUM_FIRE_HA) return 'medium'
  return 'low'
}

function assessment(
  status: HazardAssessment['status'],
  severity: HazardAssessment['severity'],
  distance: number | null,
  checkedAt: string,
  stale = false,
): HazardAssessment {
  return {
    hazard: 'wildfire',
    status,
    severity,
    distanceMeters: distance == null ? null : Math.round(distance),
    sourceLabel: EFFIS_SOURCE.label,
    sourceUrl: EFFIS_SOURCE.sourceUrl,
    checkedAt,
    ...(stale ? { stale: true } : {}),
  }
}

async function fetchBurntAreaGmlPage(
  fetchImpl: typeof fetch,
  serviceUrl: string,
  options: { bbox: [number, number, number, number]; startIndex: number; pageSize: number },
): Promise<string> {
  const url = new URL(serviceUrl)
  url.searchParams.set('service', 'WFS')
  url.searchParams.set('version', '1.1.0')
  url.searchParams.set('request', 'GetFeature')
  url.searchParams.set('typename', 'modis.ba.poly')
  url.searchParams.set('outputformat', 'GML3')
  url.searchParams.set('bbox', `${options.bbox.join(',')},urn:ogc:def:crs:OGC:1.3:CRS84`)
  url.searchParams.set('maxfeatures', String(options.pageSize))
  url.searchParams.set('startindex', String(options.startIndex))

  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`Copernicus EFFIS request failed: ${response.status} ${response.statusText}`)
  const body = await response.text()
  if (!body.includes('FeatureCollection')) {
    throw new Error('Copernicus EFFIS response was not a WFS FeatureCollection')
  }
  return body
}

function ringFromPosList(posList: string): GeoJsonLinearRing | null {
  const numbers = posList.trim().split(/\s+/).filter(Boolean).map(Number)
  if (numbers.length < 8 || numbers.length % 2 !== 0) return null
  const ring: GeoJsonLinearRing = []
  for (let i = 0; i < numbers.length; i += 2) {
    const lat = numbers[i]
    const lng = numbers[i + 1]
    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
    ring.push([lng, lat])
  }
  return ring
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed || null
}

function isStale(generatedAt: string, checkedAt: string, maxAgeDays: number | undefined): boolean {
  if (maxAgeDays == null) return false
  const generatedTime = Date.parse(generatedAt)
  const checkedTime = Date.parse(checkedAt)
  if (!Number.isFinite(generatedTime)) return true
  if (!Number.isFinite(checkedTime)) return true
  return checkedTime - generatedTime > maxAgeDays * 24 * 60 * 60 * 1000
}
