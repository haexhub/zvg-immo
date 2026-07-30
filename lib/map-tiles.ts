const DEFAULT_MAPTILER_STREETS_MAP_ID = 'streets-v4'
const DEFAULT_MAPTILER_SATELLITE_MAP_ID = 'hybrid-v4'

export const OSM_ATTRIBUTION = '&copy; OpenStreetMap contributors'
export const MAPTILER_ATTRIBUTION = '&copy; MapTiler &copy; OpenStreetMap contributors'

export interface MapTilerTileMapIds {
  streets?: string
  streetsDe?: string
  streetsEn?: string
  satellite?: string
  satelliteDe?: string
  satelliteEn?: string
}

function normalizedMapLocale(locale: string): string {
  return locale.split('-')[0]?.toLowerCase() || 'en'
}

function configuredMapId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function mapIdForLocale(defaultMapId: string, locale: string, fallbackMapId: string | undefined, localizedMapIds: Partial<Record<'de' | 'en', string>>): string {
  const language = normalizedMapLocale(locale)
  return configuredMapId(localizedMapIds[language as 'de' | 'en'])
    ?? configuredMapId(fallbackMapId)
    ?? defaultMapId
}

export function mapTilerTileUrl(mapId: string, apiKey: string): string {
  const params = new URLSearchParams({
    key: apiKey,
  })
  return `https://api.maptiler.com/maps/${mapId}/256/{z}/{x}/{y}.png?${params}`
}

export function mapTilerStreetsUrl(locale: string, apiKey: string, mapIds: MapTilerTileMapIds = {}): string {
  const mapId = mapIdForLocale(DEFAULT_MAPTILER_STREETS_MAP_ID, locale, mapIds.streets, {
    de: mapIds.streetsDe,
    en: mapIds.streetsEn,
  })
  return mapTilerTileUrl(mapId, apiKey)
}

export function mapTilerSatelliteUrl(locale: string, apiKey: string, mapIds: MapTilerTileMapIds = {}): string {
  const mapId = mapIdForLocale(DEFAULT_MAPTILER_SATELLITE_MAP_ID, locale, mapIds.satellite, {
    de: mapIds.satelliteDe,
    en: mapIds.satelliteEn,
  })
  return mapTilerTileUrl(mapId, apiKey)
}
