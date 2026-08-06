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

/** True when a Mapbox/MapLibre `text-field` value reads a `name`-family
 *  source property (`name`, `name:xx`, `name_int`, …) — i.e. this is a
 *  place-name label layer, as opposed to house numbers, elevation labels,
 *  route shields etc., which must be left alone. Handles both the modern
 *  expression-array form (`['get', 'name:en']`) and the legacy Mapbox GL
 *  string-template form (`'{name:en}'`) — MapTiler's `streets-v2` still uses
 *  the latter for its Country/Continent/Capital-city/City/Ocean/Place labels,
 *  which is why those kept rendering in whatever language the field was
 *  hardcoded to (usually `name:en`) regardless of the chosen `lang`. */
function referencesNameField(value: unknown): boolean {
  if (typeof value === 'string') return /^\{name([:_][^}]*)?\}$/.test(value)
  if (!Array.isArray(value)) return false
  if (value[0] === 'get' && typeof value[1] === 'string' && /^name(:|_|$)/.test(value[1])) return true
  return value.some(referencesNameField)
}

function localizedNameField(lang: string): unknown[] {
  return ['coalesce', ['get', `name:${lang}`], ['get', 'name']]
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
    if (textField === undefined) continue
    // Legacy zoom-function form (e.g. MapTiler's Airport layer: IATA code at
    // low zoom, full name once zoomed in) — rewrite only the stop(s) that
    // reference a name field, leaving unrelated stops (icons, refs) as-is.
    if (textField && typeof textField === 'object' && !Array.isArray(textField) && Array.isArray((textField as { stops?: unknown }).stops)) {
      const stops = (textField as { stops: [number, unknown][] }).stops
      if (stops.some(([, stopValue]) => referencesNameField(stopValue))) {
        layer.layout!['text-field'] = {
          ...textField,
          stops: stops.map(([zoom, stopValue]) => [zoom, referencesNameField(stopValue) ? localizedNameField(lang) : stopValue]),
        }
      }
      continue
    }
    if (referencesNameField(textField)) {
      layer.layout!['text-field'] = localizedNameField(lang)
    }
  }
  return cloned
}
