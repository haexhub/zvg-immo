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
