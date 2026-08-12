import { describe, expect, it } from 'vitest'
import type { GeoJsonLinearRing } from './eu-flood-risk'
import { simplifyPolygon, simplifyRing } from './polygon-simplify'
import { distanceToPolygonMeters, pointInPolygon } from './eu-flood-risk-assessment'

/** Raster-derived outline: a square walked in small steps, the shape MODIS
 *  burnt-area polygons actually arrive in. */
function staircaseSquare(steps: number, size = 0.2): GeoJsonLinearRing {
  const ring: GeoJsonLinearRing = []
  for (let i = 0; i <= steps; i++) ring.push([13.0 + (size * i) / steps, 52.0])
  for (let i = 1; i <= steps; i++) ring.push([13.0 + size, 52.0 + (size * i) / steps])
  for (let i = 1; i <= steps; i++) ring.push([13.0 + size - (size * i) / steps, 52.0 + size])
  for (let i = 1; i <= steps; i++) ring.push([13.0, 52.0 + size - (size * i) / steps])
  return ring
}

describe('simplifyRing', () => {
  it('drops collinear detail while keeping the corners', () => {
    const ring = staircaseSquare(200)
    const simplified = simplifyRing(ring, 0.001)

    expect(ring.length).toBe(801)
    expect(simplified.length).toBe(5)
    expect(simplified[0]).toEqual([13, 52])
  })

  it('keeps detail larger than the tolerance', () => {
    const ring: GeoJsonLinearRing = [
      [13.0, 52.0],
      [13.1, 52.0],
      // ~1.1 km spike, far past a ~111 m tolerance
      [13.15, 52.01],
      [13.2, 52.0],
      [13.2, 52.2],
      [13.0, 52.2],
      [13.0, 52.0],
    ]

    expect(simplifyRing(ring, 0.001)).toContainEqual([13.15, 52.01])
  })

  it('leaves rings that cannot lose a point untouched', () => {
    const triangle: GeoJsonLinearRing = [[13, 52], [13.1, 52], [13.1, 52.1], [13, 52]]

    expect(simplifyRing(triangle, 0.5)).toBe(triangle)
    // An absurd tolerance would collapse this ring entirely — keeping the
    // original beats emitting a zone that silently stops matching.
    expect(simplifyRing(staircaseSquare(50), 90).length).toBeGreaterThanOrEqual(4)
  })

  it('handles a ring deep enough to blow a recursive implementation', () => {
    // The production cache holds one 393,217-point ring.
    const ring: GeoJsonLinearRing = Array.from(
      { length: 200_000 },
      (_, i) => [13 + i * 1e-6, 52 + Math.sin(i) * 1e-7] as [number, number],
    )
    ring.push([13, 52])

    expect(() => simplifyRing(ring, 0.001)).not.toThrow()
  })

  it('keeps the assessment a simplified zone produces within the tolerance', () => {
    const polygon = [staircaseSquare(400)]
    const simplified = simplifyPolygon(polygon, 0.001)
    const outside = { lat: 52.1, lng: 12.9 }

    expect(pointInPolygon({ lat: 52.1, lng: 13.1 }, simplified)).toBe(true)
    expect(Math.abs(
      distanceToPolygonMeters(outside, simplified) - distanceToPolygonMeters(outside, polygon),
    )).toBeLessThan(120)
  })
})
