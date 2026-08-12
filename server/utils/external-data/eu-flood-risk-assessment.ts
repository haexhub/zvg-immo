import { minOf } from '~/lib/array-math'
import { distanceMeters, type Point } from './geo'
import type { GeoJsonLinearRing, GeoJsonPolygonCoordinates } from './eu-flood-risk'

export interface GeoBounds {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

/** Bounding box over every ring of every polygon of one zone, computed once
 *  when the cache is parsed so the per-auction scan can skip zones without
 *  walking their outlines. */
export function polygonsBounds(polygons: GeoJsonPolygonCoordinates[]): GeoBounds | null {
  let minLat = Infinity; let maxLat = -Infinity; let minLng = Infinity; let maxLng = -Infinity
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [lng, lat] of ring) {
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
        if (lng < minLng) minLng = lng
        if (lng > maxLng) maxLng = lng
      }
    }
  }
  return Number.isFinite(minLat) && Number.isFinite(minLng) ? { minLat, maxLat, minLng, maxLng } : null
}

/** Distance to the closest point of the box, which is a lower bound for the
 *  distance to anything inside it — the polygon included. Zones whose box is
 *  already farther than the best exact distance found so far cannot win, so
 *  the caller can stop measuring outlines at that point. */
export function boundsDistanceMeters(point: Point, bounds: GeoBounds): number {
  const nearest = {
    lat: Math.min(Math.max(point.lat, bounds.minLat), bounds.maxLat),
    lng: Math.min(Math.max(point.lng, bounds.minLng), bounds.maxLng),
  }
  return distanceMeters(point, nearest)
}

/** Pure geometry helpers kept separate from the cache/import adapter. */
export function pointInPolygon(point: Point, polygon: GeoJsonPolygonCoordinates): boolean {
  if (!ringContainsPoint(point, polygon[0] ?? [])) return false
  return !polygon.slice(1).some((hole) => ringContainsPoint(point, hole))
}
export function distanceToPolygonMeters(point: Point, polygon: GeoJsonPolygonCoordinates): number {
  if (pointInPolygon(point, polygon)) return 0
  const rings = polygon.filter((ring) => ring.length >= 2)
  return rings.length ? minOf(rings.map((ring) => distanceToRingMeters(point, ring))) : Number.POSITIVE_INFINITY
}
function ringContainsPoint(point: Point, ring: GeoJsonLinearRing): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]?.[0]; const yi = ring[i]?.[1]; const xj = ring[j]?.[0]; const yj = ring[j]?.[1]
    if (xi == null || yi == null || xj == null || yj == null) continue
    if (((yi > point.lat) !== (yj > point.lat)) && (point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}
function distanceToRingMeters(point: Point, ring: GeoJsonLinearRing): number {
  const segments = normalizedRingSegments(ring)
  return segments.length ? minOf(segments.map(([a, b]) => distanceMeters(point, projectPointToSegment(point, a, b)))) : Number.POSITIVE_INFINITY
}
function normalizedRingSegments(ring: GeoJsonLinearRing): Array<[Point, Point]> {
  const points = ring.filter((position) => Number.isFinite(position[0]) && Number.isFinite(position[1]))
    .map((position) => ({ lng: position[0], lat: position[1] }))
  if (points.length < 2) return []
  const closed = samePoint(points[0]!, points[points.length - 1]!) ? points : [...points, points[0]!]
  return closed.slice(1).map((point, index) => [closed[index]!, point])
}
function projectPointToSegment(point: Point, a: Point, b: Point): Point {
  const latScale = 111_320; const lngScale = 111_320 * Math.cos((point.lat * Math.PI) / 180)
  const px = point.lng * lngScale; const py = point.lat * latScale; const ax = a.lng * lngScale; const ay = a.lat * latScale
  const bx = b.lng * lngScale; const by = b.lat * latScale; const dx = bx - ax; const dy = by - ay; const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return a
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
  return { lng: (ax + t * dx) / lngScale, lat: (ay + t * dy) / latScale }
}
const samePoint = (a: Point, b: Point) => a.lat === b.lat && a.lng === b.lng
