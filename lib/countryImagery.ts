import L from 'leaflet'

/** Free national orthophoto/satellite services that beat Esri World Imagery's
 *  resolution for their own country. Each entry's `bounds` is passed straight
 *  to the Leaflet layer so it only ever requests tiles inside the country —
 *  outside that box the map falls through to Esri. A handful require a free
 *  API key the user registers for themselves (see `apiKeys` below); those
 *  entries carry a `{apiKey}` placeholder in their `url` and are skipped
 *  (falling back to Esri) until a key is supplied. */
type XyzImagery = {
  kind: 'xyz'
  url: string
  subdomains?: string[]
  maxZoom: number
  maxNativeZoom?: number
  minZoom?: number
  attribution: string
  bounds: L.LatLngBoundsLiteral
}

type WmsImagery = {
  kind: 'wms'
  url: string
  layers: string
  format?: string
  maxZoom: number
  attribution: string
  bounds: L.LatLngBoundsLiteral
}

type CountryImagery = XyzImagery | WmsImagery

/** Countries researched but intentionally left out, so the reasoning isn't
 *  lost the next time someone re-evaluates: DE/HU/BA have no free nationwide
 *  source (Germany's is state-by-state, not national); IT's national WMS is
 *  a 2012 mosaic — older and lower quality than Esri; LT's only options are a
 *  non-standard ArcGIS export endpoint or a WMS restricted to non-commercial
 *  use. All of these just fall through to Esri by having no entry here. */
const COUNTRY_IMAGERY: Partial<Record<string, CountryImagery>> = {
  at: {
    kind: 'xyz',
    url: 'https://maps{s}.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg',
    subdomains: ['', '1', '2', '3', '4'],
    maxNativeZoom: 17,
    maxZoom: 19,
    attribution: 'Datenquelle: <a href="https://basemap.at">basemap.at</a>',
    bounds: [
      [46.35877, 8.782379],
      [49.037872, 17.5],
    ],
  },
  es: {
    kind: 'xyz',
    url: 'https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0&layer=OI.OrthoimageCoverage&style=default&format=image/jpeg&TileMatrixSet=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}',
    maxZoom: 19,
    attribution: 'PNOA cedido por &copy; Instituto Geogr&aacute;fico Nacional de Espa&ntilde;a',
    bounds: [
      [27.6, -18.4],
      [43.9, 4.4],
    ],
  },
  cz: {
    kind: 'xyz',
    url: 'https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/{z}/{y}/{x}',
    maxNativeZoom: 19,
    maxZoom: 20,
    attribution: '&copy; &Ccaron;&Uacute;ZK',
    bounds: [
      [48.55, 12.09],
      [51.06, 18.87],
    ],
  },
  pl: {
    kind: 'wms',
    url: 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMS/StandardResolution',
    layers: 'Raster',
    maxZoom: 19,
    attribution: '&copy; GUGiK &ndash; geoportal.gov.pl',
    bounds: [
      [48.9, 14.0],
      [54.93, 24.78],
    ],
  },
  fr: {
    kind: 'xyz',
    url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER=HR.ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM_6_19&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg',
    minZoom: 6,
    maxZoom: 19,
    attribution: '&copy; IGN-F/G&eacute;oportail',
    bounds: [
      [41.3, -5.2],
      [51.1, 9.6],
    ],
  },
  be: {
    kind: 'wms',
    url: 'https://wms.ngi.be/inspire/ortho/service',
    layers: 'orthoimage_coverage',
    format: 'image/png',
    maxZoom: 19,
    attribution: '&copy; NGI/IGN Belgium',
    bounds: [
      [49.435, 2.219],
      [51.889, 6.459],
    ],
  },
  se: {
    kind: 'wms',
    url: 'https://minkarta.lantmateriet.se/map/ortofoto/',
    layers: 'Ortofoto_0.25',
    format: 'image/png',
    maxZoom: 19,
    attribution: '&copy; Lantm&auml;teriet',
    bounds: [
      [55.3, 11.0],
      [69.1, 24.2],
    ],
  },
  // Requires a free, instant self-service key from
  // https://omatili.maanmittauslaitos.fi — skipped until CountryImageryKeys.fi
  // is set (see the mmlApiKey runtime config option).
  fi: {
    kind: 'xyz',
    url: 'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/ortokuva/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.jpg?api-key={apiKey}',
    maxZoom: 18,
    attribution: '&copy; Maanmittauslaitos',
    bounds: [
      [59.6, 19.0],
      [70.1, 31.6],
    ],
  },
  // Requires a free, instant self-service key from
  // https://datafordeler.dk — skipped until CountryImageryKeys.dk is set (see
  // the datafordelerApiKey runtime config option).
  dk: {
    kind: 'wms',
    url: 'https://wms.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS?apikey={apiKey}',
    layers: 'orto_foraar',
    maxZoom: 19,
    attribution: '&copy; Klimadatastyrelsen (SDFI)',
    bounds: [
      [54.5, 8.0],
      [57.8, 15.2],
    ],
  },
}

export const COUNTRY_IMAGERY_CODES = Object.keys(COUNTRY_IMAGERY)

/** Free-tier API keys for the countries that need one. Missing/empty keys
 *  just make that country's layer skip itself — never an error. */
export type CountryImageryKeys = Partial<Record<string, string>>

function resolveUrl(config: CountryImagery, apiKeys: CountryImageryKeys, code: string): string | null {
  if (!config.url.includes('{apiKey}')) return config.url
  const key = apiKeys[code]
  if (!key) return null
  return config.url.replace('{apiKey}', encodeURIComponent(key))
}

/** Builds a country's high-res imagery layer, or null when none is
 *  configured (or its required API key is missing) — caller should fall
 *  back to Esri in that case. */
export function createCountryImageryLayer(
  country: string | null | undefined,
  apiKeys: CountryImageryKeys = {},
): L.Layer | null {
  const config = country ? COUNTRY_IMAGERY[country] : undefined
  if (!config) return null
  const url = resolveUrl(config, apiKeys, country as string)
  if (url == null) return null
  const bounds = L.latLngBounds(config.bounds)
  if (config.kind === 'wms') {
    return L.tileLayer.wms(url, {
      layers: config.layers,
      styles: '',
      format: config.format ?? 'image/jpeg',
      version: '1.3.0',
      crs: L.CRS.EPSG3857,
      maxZoom: config.maxZoom,
      attribution: config.attribution,
      bounds,
    })
  }
  return L.tileLayer(url, {
    subdomains: config.subdomains ?? 'abc',
    minZoom: config.minZoom,
    maxZoom: config.maxZoom,
    maxNativeZoom: config.maxNativeZoom,
    attribution: config.attribution,
    bounds,
  })
}

/** All configured per-country layers stacked over Esri — each only ever
 *  requests tiles inside its own `bounds`, so this is safe to add wholesale
 *  as an overlay on a map that spans several countries at once. */
export function createAllCountryImageryLayers(apiKeys: CountryImageryKeys = {}): L.Layer[] {
  return COUNTRY_IMAGERY_CODES.map((code) => createCountryImageryLayer(code, apiKeys)).filter(
    (layer): layer is L.Layer => layer !== null,
  )
}
