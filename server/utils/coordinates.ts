/**
 * A crawler-supplied position we can trust. Sources signal "no location" in
 * several ways: an empty attribute that `Number('')` turns into 0 (dga-ag), an
 * explicit `[0, 0]` (zvbawu), NaN. A position of exactly 0/0 ("null island",
 * the Gulf of Guinea) is never a real property in any country we cover, so it
 * counts as missing — otherwise the geocoder skips the address and every
 * proximity lookup runs against the middle of the ocean.
 */
export function usableCoordinates(
  lat: number | null | undefined,
  lng: number | null | undefined,
): { lat: number; lng: number } | null {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return lat === 0 && lng === 0 ? null : { lat, lng }
}

export function hasUsableCoordinates(lat: number | null | undefined, lng: number | null | undefined): boolean {
  return usableCoordinates(lat, lng) != null
}
