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

// Geocoders return slightly different coordinates for the same address between
// runs, so an exact comparison would re-enrich constantly. 100 m is well above
// that noise and well below the distance at which the location context (nearby
// amenities, hazard zones, noise bands) would meaningfully differ.
const COORDINATE_CHANGE_THRESHOLD_METERS = 100

/**
 * Whether `next` is a real relocation of `previous`. Also used by the
 * enrichment run to drop location data that describes the old position.
 */
export function coordinatesMovedSignificantly(
  previous: { lat: number | null; lng: number | null } | null,
  next: { lat: number | null; lng: number | null },
): boolean {
  if (next.lat == null || next.lng == null) return false
  // First coordinates this auction ever had — including a brand new auction,
  // whose identity row is created before any geocoding has run.
  if (previous?.lat == null || previous?.lng == null) return true
  return distanceMeters({ lat: previous.lat, lng: previous.lng }, { lat: next.lat, lng: next.lng }) > COORDINATE_CHANGE_THRESHOLD_METERS
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}
