const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'

export function encodeGeohash(lat: number, lng: number, precision = 5): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return ''
  let latRange: [number, number] = [-90, 90]
  let lngRange: [number, number] = [-180, 180]
  let even = true
  let bit = 0
  let ch = 0
  let geohash = ''

  while (geohash.length < precision) {
    if (even) {
      const mid = (lngRange[0] + lngRange[1]) / 2
      if (lng >= mid) {
        ch = (ch << 1) + 1
        lngRange = [mid, lngRange[1]]
      } else {
        ch <<= 1
        lngRange = [lngRange[0], mid]
      }
    } else {
      const mid = (latRange[0] + latRange[1]) / 2
      if (lat >= mid) {
        ch = (ch << 1) + 1
        latRange = [mid, latRange[1]]
      } else {
        ch <<= 1
        latRange = [latRange[0], mid]
      }
    }

    even = !even
    if (++bit === 5) {
      geohash += BASE32[ch]
      bit = 0
      ch = 0
    }
  }

  return geohash
}

/**
 * Every cell at `precision` that the bounding box of a circle around the point
 * touches. A radius lookup keyed by the point's own cell alone misses matches
 * just across a cell edge, which near the edge can be most of the circle.
 */
export function geohashesWithinRadius(lat: number, lng: number, radiusMeters: number, precision = 5): string[] {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return []
  // Geohash bits alternate starting with longitude, so lng gets the odd bit.
  const cellLat = 180 / 2 ** Math.floor((5 * precision) / 2)
  const cellLng = 360 / 2 ** Math.ceil((5 * precision) / 2)
  const deltaLat = radiusMeters / METERS_PER_DEGREE_LAT
  const deltaLng = radiusMeters / (METERS_PER_DEGREE_LAT * Math.max(Math.cos((lat * Math.PI) / 180), 0.01))
  const minLat = Math.max(lat - deltaLat, -90)
  const maxLat = Math.min(lat + deltaLat, 90)
  // ponytail: clamps at the antimeridian instead of wrapping; fine for the
  // European sources using this, wrap lng if a Pacific source ever does.
  const minLng = Math.max(lng - deltaLng, -180)
  const maxLng = Math.min(lng + deltaLng, 180)

  const cells = new Set<string>()
  // Stepping by one cell size and always visiting the far edge hits every
  // cell the box overlaps.
  for (let y = minLat; ; y = Math.min(y + cellLat, maxLat)) {
    for (let x = minLng; ; x = Math.min(x + cellLng, maxLng)) {
      cells.add(encodeGeohash(y, x, precision))
      if (x >= maxLng) break
    }
    if (y >= maxLat) break
  }
  return [...cells]
}

const METERS_PER_DEGREE_LAT = 111_320
