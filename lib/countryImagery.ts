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
  /** Server paints solid white (no alpha channel) outside its actual
   *  coverage instead of returning a transparent/no-data pixel — treat
   *  near-white pixels as no-data client-side so Esri shows through the
   *  bbox's spillover into neighbouring countries. */
  chromaKeyWhite?: boolean
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
    // Cap at Esri's 19 even though the service natively serves 19+overzoom:
    // a single layer with a higher maxZoom raises the whole map's zoom
    // ceiling, and at zoom 20 Leaflet unloads every other imagery layer
    // (all maxZoom 19), leaving a blank map outside Czechia.
    maxZoom: 19,
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
    // png, not jpeg: the bounds box unavoidably includes a strip of eastern
    // Germany (Cottbus, Görlitz), where this WMS paints opaque white with
    // jpeg — png + transparent lets Esri show through there instead.
    format: 'image/png',
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
    // Same spillover as the pl/dk bboxes (this one reaches into Belgium,
    // Luxembourg, Switzerland and northern Spain), but IGN only serves this
    // layer as opaque jpeg — GetTile with FORMAT=image/png 400s ("Format
    // image/png unknown") — so png+transparent isn't an option. Chroma-key
    // instead: IGN already clips to France's real border and fills outside
    // it solid white, so treating white as no-data recovers the same effect.
    chromaKeyWhite: true,
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
    // png, not jpeg: the bounds box includes Flensburg/Kiel and Skåne, where
    // an opaque no-data fill would cover Esri (see the pl entry).
    format: 'image/png',
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

/** Renders each tile onto a canvas and makes near-white pixels transparent,
 *  so a source that only offers opaque no-data fill still lets the layer
 *  underneath (Esri) show through outside its actual coverage. */
const ChromaKeyWhiteTileLayer = L.TileLayer.extend({
  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const tile = document.createElement('canvas')
    const size = this.getTileSize()
    tile.width = size.x
    tile.height = size.y
    const ctx = tile.getContext('2d')!
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      ctx.drawImage(img, 0, 0, size.x, size.y)
      try {
        const frame = ctx.getImageData(0, 0, size.x, size.y)
        const px = frame.data
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i] as number
          const g = px[i + 1] as number
          const b = px[i + 2] as number
          if (r > 250 && g > 250 && b > 250) px[i + 3] = 0
        }
        ctx.putImageData(frame, 0, 0)
      } catch {
        // Canvas tainted (response missing CORS headers) — leave it opaque.
      }
      done(undefined, tile)
    }
    img.onerror = () => done(new Error('tile load failed'), tile)
    img.src = this.getTileUrl(coords)
    return tile
  },
}) as unknown as typeof L.TileLayer

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
  if (!country) return null
  const config = COUNTRY_IMAGERY[country]
  if (!config) return null
  const url = resolveUrl(config, apiKeys, country)
  if (url == null) return null
  const bounds = L.latLngBounds(config.bounds)
  if (config.kind === 'wms') {
    const format = config.format ?? 'image/jpeg'
    return L.tileLayer.wms(url, {
      layers: config.layers,
      styles: '',
      format,
      // png entries chose png precisely because their bounds box overlaps
      // neighbouring countries — request transparent no-data fill so the
      // Esri layer underneath shows through there.
      transparent: format === 'image/png',
      version: '1.3.0',
      crs: L.CRS.EPSG3857,
      maxZoom: config.maxZoom,
      attribution: config.attribution,
      bounds,
    })
  }
  const TileLayerClass = config.chromaKeyWhite ? ChromaKeyWhiteTileLayer : L.TileLayer
  return new TileLayerClass(url, {
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
