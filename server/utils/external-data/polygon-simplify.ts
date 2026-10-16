import type { GeoJsonLinearRing, GeoJsonPolygonCoordinates } from './eu-flood-risk'

/**
 * Ramer-Douglas-Peucker on a lng/lat ring, tolerance in degrees of latitude.
 *
 * For sources that hand out full-resolution outlines this is what keeps a
 * cache openable: the EEA flood layer is generalized server-side via ArcGIS's
 * maxAllowableOffset, but EFFIS's WFS has no such parameter, so its
 * raster-derived burnt-area outlines arrive with every 250 m cell corner in
 * them (measured 2026-08-11: 8.25M vertices over 31,192 zones, 182 MB on
 * disk, 602 MB parsed).
 *
 * Longitude is scaled by cos(latitude) so the tolerance means about the same
 * distance on both axes; the scale is taken once per ring, which is accurate
 * enough for outlines this small.
 */
export function simplifyRing(ring: GeoJsonLinearRing, toleranceDegrees: number): GeoJsonLinearRing {
  // A closed triangle is the smallest ring worth keeping — below that there is
  // nothing to drop without destroying the polygon.
  if (ring.length <= 4 || toleranceDegrees <= 0) return ring
  const lngScale = Math.cos((ring[0]![1] * Math.PI) / 180)
  const keep = new Uint8Array(ring.length)
  keep[0] = 1
  keep[ring.length - 1] = 1

  // Iterative rather than recursive: a single burnt-area ring reached 393,217
  // points in the production cache, deep enough to blow the call stack.
  const stack: Array<[number, number]> = [[0, ring.length - 1]]
  while (stack.length > 0) {
    const [start, end] = stack.pop()!
    let maxDistance = 0
    let maxIndex = -1
    for (let index = start + 1; index < end; index++) {
      const distance = perpendicularDistance(ring[index]!, ring[start]!, ring[end]!, lngScale)
      if (distance > maxDistance) {
        maxDistance = distance
        maxIndex = index
      }
    }
    if (maxIndex >= 0 && maxDistance > toleranceDegrees) {
      keep[maxIndex] = 1
      stack.push([start, maxIndex], [maxIndex, end])
    }
  }

  const simplified = ring.filter((_, index) => keep[index] === 1)
  // Keep the original rather than emit a degenerate ring: a zone that
  // simplifies away entirely would silently stop matching.
  return simplified.length >= 4 ? simplified : ring
}

export function simplifyPolygon(
  polygon: GeoJsonPolygonCoordinates,
  toleranceDegrees: number,
): GeoJsonPolygonCoordinates {
  return polygon.map((ring) => simplifyRing(ring, toleranceDegrees))
}

function perpendicularDistance(
  point: GeoJsonLinearRing[number],
  start: GeoJsonLinearRing[number],
  end: GeoJsonLinearRing[number],
  lngScale: number,
): number {
  const px = point[0] * lngScale; const py = point[1]
  const ax = start[0] * lngScale; const ay = start[1]
  const bx = end[0] * lngScale; const by = end[1]
  const dx = bx - ax; const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}
