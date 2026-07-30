const MAPTILER_STREETS_MAP_ID = 'streets-v4'
const MAPTILER_SATELLITE_MAP_ID = 'hybrid'

export const OSM_ATTRIBUTION = '&copy; OpenStreetMap contributors'
export const MAPTILER_ATTRIBUTION = '&copy; MapTiler &copy; OpenStreetMap contributors'

export function normalizedMapLanguage(locale: string): string {
  return locale.split('-')[0]?.toLowerCase() || 'en'
}

export function localizedMapTilerTileUrl(mapId: string, locale: string, apiKey: string): string {
  const params = new URLSearchParams({
    key: apiKey,
    language: normalizedMapLanguage(locale),
  })
  return `https://api.maptiler.com/maps/${mapId}/256/{z}/{x}/{y}.png?${params}`
}

export function mapTilerStreetsUrl(locale: string, apiKey: string): string {
  return localizedMapTilerTileUrl(MAPTILER_STREETS_MAP_ID, locale, apiKey)
}

export function mapTilerSatelliteUrl(locale: string, apiKey: string): string {
  return localizedMapTilerTileUrl(MAPTILER_SATELLITE_MAP_ID, locale, apiKey)
}
