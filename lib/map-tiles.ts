export const OSM_ATTRIBUTION = '&copy; OpenStreetMap contributors'

const DEFAULT_MAPTILER_STREETS_STYLE_ID = 'streets-v2'
const DEFAULT_MAPTILER_SATELLITE_STYLE_ID = 'hybrid'

function configuredStyleId(value: string | undefined, defaultId: string): string {
  return value?.trim() || defaultId
}

/** MapTiler style.json URL, rendered as vector tiles via ol-mapbox-style. One
 *  style covers every UI locale — see localizeVectorStyleLanguage — unlike
 *  the raster tiles this replaced, whose label language was baked into the
 *  style at MapTiler-Cloud creation time and needed one style per language. */
export function mapTilerStyleUrl(styleId: string, apiKey: string): string {
  const params = new URLSearchParams({ key: apiKey })
  return `https://api.maptiler.com/maps/${styleId}/style.json?${params}`
}

export function mapTilerStreetsStyleUrl(apiKey: string, styleId?: string): string {
  return mapTilerStyleUrl(configuredStyleId(styleId, DEFAULT_MAPTILER_STREETS_STYLE_ID), apiKey)
}

export function mapTilerSatelliteStyleUrl(apiKey: string, styleId?: string): string {
  return mapTilerStyleUrl(configuredStyleId(styleId, DEFAULT_MAPTILER_SATELLITE_STYLE_ID), apiKey)
}

export interface MapboxLayer {
  layout?: { 'text-field'?: unknown } & Record<string, unknown>
  [key: string]: unknown
}

export interface MapboxStyle {
  layers?: MapboxLayer[]
  [key: string]: unknown
}

/** True when a Mapbox/MapLibre `text-field` expression reads a `name`-family
 *  source property (`name`, `name:xx`, `name_int`, …) — i.e. this is a
 *  place-name label layer, as opposed to house numbers, elevation labels,
 *  route shields etc., which must be left alone. */
function referencesNameField(expression: unknown): boolean {
  if (!Array.isArray(expression)) return false
  if (expression[0] === 'get' && typeof expression[1] === 'string' && /^name(:|_|$)/.test(expression[1])) {
    return true
  }
  return expression.some(referencesNameField)
}

/** Rewrites every place-name label layer's `text-field` to prefer the given
 *  language's OpenMapTiles `name:{lang}` field, falling back to the feature's
 *  native `name` when untranslated — the same technique the
 *  maplibre-gl-language plugin uses, applied here because OpenLayers has no
 *  equivalent of MapLibre GL JS's live `map.setLayoutProperty`: the style
 *  must be re-localized and the vector layer re-applied on locale change.
 *  Returns a new object; the input is not mutated. */
export function localizeVectorStyleLanguage(style: MapboxStyle, lang: string): MapboxStyle {
  const cloned = JSON.parse(JSON.stringify(style)) as MapboxStyle
  for (const layer of cloned.layers ?? []) {
    const textField = layer.layout?.['text-field']
    if (textField !== undefined && referencesNameField(textField)) {
      layer.layout!['text-field'] = ['coalesce', ['get', `name:${lang}`], ['get', 'name']]
    }
  }
  return cloned
}
