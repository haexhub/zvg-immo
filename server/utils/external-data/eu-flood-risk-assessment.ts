import { minOf } from '~/lib/array-math'
import { distanceMeters, type Point } from './geo'
import type { GeoJsonLinearRing, GeoJsonPolygonCoordinates } from './eu-flood-risk'

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
