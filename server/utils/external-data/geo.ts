export interface Point {
  lat: number
  lng: number
}

const EARTH_RADIUS_METERS = 6_371_000

export function distanceMeters(a: Point, b: Point): number {
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)
  const deltaLat = toRadians(b.lat - a.lat)
  const deltaLng = toRadians(b.lng - a.lng)
  const hav =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(hav), Math.sqrt(1 - hav))
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}
