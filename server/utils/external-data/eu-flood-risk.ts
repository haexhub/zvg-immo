import { readFile } from 'node:fs/promises'
import type { Auction, HazardAssessment } from '~/types/auction'
import type { HazardAssessmentAdapter } from '~/server/tasks/external-enrichment'
import { minOf } from '~/lib/array-math'
import { readCachedFileCollection } from './cached-file-collection'
import { distanceMeters, type Point } from './geo'
import { EXTERNAL_DATA_SOURCES } from './sources'
import {
  boundsDistanceMeters,
  distanceToPolygonMeters,
  pointInPolygon,
  polygonsBounds,
  type GeoBounds,
} from './eu-flood-risk-assessment'

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
  /** Derived at parse time, not part of the cache file. */
  bounds: GeoBounds | null
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

const DEFAULT_NEARBY_DISTANCE_METERS = 1_000
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
      bounds: polygonsBounds(polygons),
    }]
  })

  return {
    sourceVersion,
    generatedAt,
    zones,
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

  const nearest = nearestZone(point, collection.zones)
  if (!nearest || !Number.isFinite(nearest.distanceMeters)) {
    return assessment('unknown', 'unknown', null, checkedAt)
  }

  if (zoneContainsPoint(nearest.zone, point)) {
    return assessment('inside', nearest.zone.severity, 0, checkedAt)
  }

  if (nearest.distanceMeters <= nearbyDistanceMeters) {
    return assessment('nearby', nearest.zone.severity, nearest.distanceMeters, checkedAt)
  }

  return assessment('outside', 'unknown', nearest.distanceMeters, checkedAt)
}

export async function createEuFloodRiskFileAdapter(
  options: FloodRiskFileAdapterOptions,
): Promise<HazardAssessmentAdapter> {
  // Cached by mtime: external-enrichment rebuilds its adapters per call and
  // fires one call per auction, so an uncached parse here happens dozens of
  // times concurrently (see cached-file-collection.ts).
  const collection = await readCachedFileCollection(
    options.geoJsonPath,
    (path) => readFloodRiskGeoJson(path, options.sourceVersion),
    options.sourceVersion ?? '',
  )
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

function isStale(generatedAt: string, checkedAt: string, maxAgeDays: number | undefined): boolean {
  if (maxAgeDays == null) return false
  const generatedTime = Date.parse(generatedAt)
  const checkedTime = Date.parse(checkedAt)
  if (!Number.isFinite(generatedTime)) return true
  if (!Number.isFinite(checkedTime)) return true
  return checkedTime - generatedTime > maxAgeDays * 24 * 60 * 60 * 1000
}

/**
 * Nearest zone by exact outline distance, but measured only for the zones
 * that can still win: candidates are ordered by their bounding box distance
 * (a lower bound for the outline distance), and the walk stops as soon as
 * that lower bound passes the best exact distance found so far. Zones without
 * usable coordinates get an infinite bound, so they are measured only while
 * no finite best distance exists yet — once any bounded zone has set one,
 * an unbounded zone is skipped without ever being checked, even if it would
 * have been the true nearest (or containing) match.
 */
function nearestZone(
  point: Point,
  zones: FloodRiskZone[],
): { zone: FloodRiskZone; distanceMeters: number } | null {
  const candidates = zones
    .map((zone) => ({
      zone,
      lowerBound: zone.bounds ? boundsDistanceMeters(point, zone.bounds) : Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.lowerBound - b.lowerBound)

  let best: { zone: FloodRiskZone; distanceMeters: number } | null = null
  for (const candidate of candidates) {
    if (best && candidate.lowerBound > best.distanceMeters) break
    const distanceMeters = distanceToZoneMeters(point, candidate.zone)
    if (!best || distanceMeters < best.distanceMeters) {
      best = { zone: candidate.zone, distanceMeters }
    }
    if (distanceMeters === 0) break
  }
  return best
}

function zoneContainsPoint(zone: FloodRiskZone, point: Point): boolean {
  return zone.polygons.some((polygon) => pointInPolygon(point, polygon))
}

function distanceToZoneMeters(point: Point, zone: FloodRiskZone): number {
  return minOf(zone.polygons.map((polygon) => distanceToPolygonMeters(point, polygon)))
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

export function isFeatureCollection(input: unknown): input is FloodRiskFeatureCollection {
  if (!input || typeof input !== 'object') return false
  const candidate = input as Partial<FloodRiskFeatureCollection>
  return candidate.type === 'FeatureCollection' && Array.isArray(candidate.features)
}

export function isFeature(input: unknown): input is FloodRiskFeature {
  if (!input || typeof input !== 'object') return false
  return (input as Partial<FloodRiskFeature>).type === 'Feature'
}
