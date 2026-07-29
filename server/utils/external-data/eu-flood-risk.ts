import { readFile } from 'node:fs/promises'
import type { Auction, HazardAssessment } from '~/types/auction'
import type { HazardAssessmentAdapter } from '~/server/tasks/external-enrichment'
import { writeJsonCache } from '../json-cache'
import { distanceMeters, type Point } from './geo'
import { EXTERNAL_DATA_SOURCES } from './sources'

export type GeoJsonPosition = [number, number] | [number, number, number]
export type GeoJsonLinearRing = GeoJsonPosition[]
export type GeoJsonPolygonCoordinates = GeoJsonLinearRing[]
export type GeoJsonMultiPolygonCoordinates = GeoJsonPolygonCoordinates[]

export interface FloodRiskFeature {
  type: 'Feature'
  properties?: Record<string, unknown> | null
  geometry?: {
    type: 'Polygon' | 'MultiPolygon'
    coordinates: GeoJsonPolygonCoordinates | GeoJsonMultiPolygonCoordinates
  } | null
}

export interface FloodRiskFeatureCollection {
  type: 'FeatureCollection'
  properties?: Record<string, unknown> | null
  features: FloodRiskFeature[]
}

export interface FloodRiskZone {
  id: string
  polygons: GeoJsonPolygonCoordinates[]
  severity: HazardAssessment['severity']
  properties: Record<string, unknown>
}

export interface FloodRiskZoneCollection {
  sourceVersion: string
  generatedAt: string
  zones: FloodRiskZone[]
}

export interface FloodRiskEvaluationOptions {
  nearbyDistanceMeters?: number
  checkedAt?: string
  maxCacheAgeDays?: number
}

export interface FloodRiskFileAdapterOptions extends FloodRiskEvaluationOptions {
  geoJsonPath: string
  sourceVersion?: string
}

export interface ImportEuFloodRiskCacheOptions {
  cachePath: string
  serviceUrl?: string
  sourceVersion?: string
  generatedAt?: string
  pageSize?: number
  maxPages?: number
  countryCodes?: string[]
  fetchImpl?: typeof fetch
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

const DEFAULT_NEARBY_DISTANCE_METERS = 1_000
const DEFAULT_PAGE_SIZE = 2_000
export const EU_FLOOD_RISK_SOURCE_VERSION = 'eea-floods-ref-v03-r00-2025-08-05'
export const EU_FLOOD_RISK_POLYGON_LAYER_URL =
  'https://water.discomap.eea.europa.eu/arcgis/rest/services/FloodsDirective/FloodsRiskZone_WM/MapServer/2'
const FLOOD_SOURCE = EXTERNAL_DATA_SOURCES.find((source) => source.id === 'eu-flood-risk-areas')!

export async function readFloodRiskGeoJson(path: string, sourceVersion?: string): Promise<FloodRiskZoneCollection> {
  return loadFloodRiskGeoJson(await readFile(path, 'utf8'), {
    sourceVersion: sourceVersion ?? '',
  })
}

export function loadFloodRiskGeoJson(
  content: string,
  options: { sourceVersion?: string; generatedAt?: string },
): FloodRiskZoneCollection {
  const parsed = JSON.parse(content) as unknown
  return normalizeFloodRiskFeatureCollection(parsed, options)
}

export function normalizeFloodRiskFeatureCollection(
  input: unknown,
  options: { sourceVersion?: string; generatedAt?: string },
): FloodRiskZoneCollection {
  const metadata = isFeatureCollection(input) ? input.properties ?? {} : {}
  const sourceVersion = options.sourceVersion || stringProperty(metadata, 'sourceVersion') || 'unknown'
  const generatedAt = options.generatedAt ?? stringProperty(metadata, 'generatedAt') ?? new Date().toISOString()
  if (!isFeatureCollection(input)) {
    return {
      sourceVersion,
      generatedAt,
      zones: [],
    }
  }

  const zones = input.features.flatMap((feature, index): FloodRiskZone[] => {
    if (!isFeature(feature)) return []
    const polygons = polygonsForFeature(feature)
    if (polygons.length === 0) return []
    const properties = feature.properties ?? {}
    return [{
      id: idForFeature(properties, index),
      polygons,
      severity: severityFromProperties(properties),
      properties,
    }]
  })

  return {
    sourceVersion,
    generatedAt,
    zones,
  }
}

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
    const page = await fetchArcGisGeoJsonPage(fetchImpl, serviceUrl, {
      where,
      offset,
      pageSize,
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

export function buildFloodHazardAssessment(
  auction: Auction,
  collection: FloodRiskZoneCollection,
  options: FloodRiskEvaluationOptions = {},
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
      inside: zoneContainsPoint(zone, point),
      distanceMeters: distanceToZoneMeters(point, zone),
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)

  const inside = matches.find((match) => match.inside)
  if (inside) {
    return assessment('inside', inside.zone.severity, 0, checkedAt)
  }

  const nearest = matches[0]
  if (!nearest || !Number.isFinite(nearest.distanceMeters)) {
    return assessment('unknown', 'unknown', null, checkedAt)
  }

  if (nearest.distanceMeters <= nearbyDistanceMeters) {
    return assessment('nearby', nearest.zone.severity, nearest.distanceMeters, checkedAt)
  }

  return assessment('outside', 'unknown', nearest.distanceMeters, checkedAt)
}

export async function createEuFloodRiskFileAdapter(
  options: FloodRiskFileAdapterOptions,
): Promise<HazardAssessmentAdapter> {
  const collection = await readFloodRiskGeoJson(options.geoJsonPath, options.sourceVersion)
  return {
    id: 'eu-flood-risk-file-cache',
    sourceVersion: options.sourceVersion ?? collection.sourceVersion,
    supports: (auction) => auction.lat != null && auction.lng != null,
    async assess(auction) {
      const result = buildFloodHazardAssessment(auction, collection, options)
      return result ? [result] : []
    },
  }
}

export function pointInPolygon(point: Point, polygon: GeoJsonPolygonCoordinates): boolean {
  if (!ringContainsPoint(point, polygon[0] ?? [])) return false
  return !polygon.slice(1).some((hole) => ringContainsPoint(point, hole))
}

export function distanceToPolygonMeters(point: Point, polygon: GeoJsonPolygonCoordinates): number {
  if (pointInPolygon(point, polygon)) return 0
  const rings = polygon.filter((ring) => ring.length >= 2)
  if (rings.length === 0) return Number.POSITIVE_INFINITY
  return Math.min(...rings.map((ring) => distanceToRingMeters(point, ring)))
}

function assessment(
  status: HazardAssessment['status'],
  severity: HazardAssessment['severity'],
  distance: number | null,
  checkedAt: string,
  stale = false,
): HazardAssessment {
  return {
    hazard: 'flood',
    status,
    severity,
    distanceMeters: distance == null ? null : Math.round(distance),
    sourceLabel: FLOOD_SOURCE.label,
    sourceUrl: FLOOD_SOURCE.sourceUrl,
    checkedAt,
    ...(stale ? { stale: true } : {}),
  }
}

async function fetchArcGisGeoJsonPage(
  fetchImpl: typeof fetch,
  serviceUrl: string,
  options: { where: string; offset: number; pageSize: number },
): Promise<FloodRiskFeatureCollection> {
  const url = new URL(`${serviceUrl.replace(/\/$/, '')}/query`)
  url.searchParams.set('f', 'geojson')
  url.searchParams.set('where', options.where)
  url.searchParams.set('outFields', '*')
  url.searchParams.set('returnGeometry', 'true')
  url.searchParams.set('outSR', '4326')
  url.searchParams.set('orderByFields', 'OBJECTID')
  url.searchParams.set('resultOffset', String(options.offset))
  url.searchParams.set('resultRecordCount', String(options.pageSize))

  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`EU flood risk request failed: ${response.status} ${response.statusText}`)
  const body = await response.json() as unknown
  if (hasArcGisError(body)) {
    throw new Error(`EU flood risk request failed: ${body.error.message}`)
  }
  if (!isFeatureCollection(body)) {
    throw new Error('EU flood risk response was not a GeoJSON FeatureCollection')
  }
  return body
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

function isStale(generatedAt: string, checkedAt: string, maxAgeDays: number | undefined): boolean {
  if (maxAgeDays == null) return false
  const generatedTime = Date.parse(generatedAt)
  const checkedTime = Date.parse(checkedAt)
  if (!Number.isFinite(generatedTime)) return true
  if (!Number.isFinite(checkedTime)) return true
  return checkedTime - generatedTime > maxAgeDays * 24 * 60 * 60 * 1000
}

function zoneContainsPoint(zone: FloodRiskZone, point: Point): boolean {
  return zone.polygons.some((polygon) => pointInPolygon(point, polygon))
}

function distanceToZoneMeters(point: Point, zone: FloodRiskZone): number {
  return Math.min(...zone.polygons.map((polygon) => distanceToPolygonMeters(point, polygon)))
}

function ringContainsPoint(point: Point, ring: GeoJsonLinearRing): boolean {
  let inside = false
  const x = point.lng
  const y = point.lat
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]?.[0]
    const yi = ring[i]?.[1]
    const xj = ring[j]?.[0]
    const yj = ring[j]?.[1]
    if (xi == null || yi == null || xj == null || yj == null) continue
    const intersects = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
    if (intersects) inside = !inside
  }
  return inside
}

function distanceToRingMeters(point: Point, ring: GeoJsonLinearRing): number {
  const segments = normalizedRingSegments(ring)
  if (segments.length === 0) return Number.POSITIVE_INFINITY
  return Math.min(...segments.map(([a, b]) => distanceToSegmentMeters(point, a, b)))
}

function normalizedRingSegments(ring: GeoJsonLinearRing): Array<[Point, Point]> {
  const points = ring
    .filter((position) => Number.isFinite(position[0]) && Number.isFinite(position[1]))
    .map((position) => ({ lng: position[0], lat: position[1] }))
  if (points.length < 2) return []
  const closed = samePoint(points[0]!, points[points.length - 1]!)
    ? points
    : [...points, points[0]!]
  return closed.slice(1).map((point, index) => [closed[index]!, point])
}

function distanceToSegmentMeters(point: Point, a: Point, b: Point): number {
  const projected = projectPointToSegment(point, a, b)
  return distanceMeters(point, projected)
}

function projectPointToSegment(point: Point, a: Point, b: Point): Point {
  const latScale = 111_320
  const lngScale = 111_320 * Math.cos(toRadians(point.lat))
  const px = point.lng * lngScale
  const py = point.lat * latScale
  const ax = a.lng * lngScale
  const ay = a.lat * latScale
  const bx = b.lng * lngScale
  const by = b.lat * latScale
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return a
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
  return {
    lng: (ax + t * dx) / lngScale,
    lat: (ay + t * dy) / latScale,
  }
}

function polygonsForFeature(feature: FloodRiskFeature): GeoJsonPolygonCoordinates[] {
  const geometry = feature.geometry
  if (!geometry) return []
  if (geometry.type === 'Polygon') return [geometry.coordinates as GeoJsonPolygonCoordinates].filter(validPolygon)
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as GeoJsonMultiPolygonCoordinates).filter(validPolygon)
  return []
}

function validPolygon(polygon: GeoJsonPolygonCoordinates): boolean {
  return Array.isArray(polygon) && Array.isArray(polygon[0]) && polygon[0]!.length >= 4
}

function severityFromProperties(properties: Record<string, unknown>): HazardAssessment['severity'] {
  const raw = firstString(properties, [
    'severity',
    'risk',
    'risk_level',
    'riskLevel',
    'hazard',
    'hazard_level',
    'hazardLevel',
    'probability',
  ])
  if (!raw) return 'unknown'
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (['very_high', 'veryhigh', 'extreme'].includes(normalized)) return 'very_high'
  if (['high', 'hoch', 'haute'].includes(normalized)) return 'high'
  if (['medium', 'moderate', 'mittel', 'moyen'].includes(normalized)) return 'medium'
  if (['low', 'niedrig', 'faible'].includes(normalized)) return 'low'
  return 'unknown'
}

function firstString(properties: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = properties[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function stringProperty(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function idForFeature(properties: Record<string, unknown>, index: number): string {
  for (const key of ['id', 'ID', 'identifier', 'objectid', 'OBJECTID']) {
    const value = properties[key]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return `flood-zone-${index + 1}`
}

function isFeatureCollection(input: unknown): input is FloodRiskFeatureCollection {
  if (!input || typeof input !== 'object') return false
  const candidate = input as Partial<FloodRiskFeatureCollection>
  return candidate.type === 'FeatureCollection' && Array.isArray(candidate.features)
}

function isFeature(input: unknown): input is FloodRiskFeature {
  if (!input || typeof input !== 'object') return false
  return (input as Partial<FloodRiskFeature>).type === 'Feature'
}

function samePoint(a: Point, b: Point): boolean {
  return a.lat === b.lat && a.lng === b.lng
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}
