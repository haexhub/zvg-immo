import TileLayer from 'ol/layer/Tile'
import XYZ from 'ol/source/XYZ'
import TileWMS from 'ol/source/TileWMS'
import { transformExtent } from 'ol/proj'
import type { Extent } from 'ol/extent'
import type Tile from 'ol/Tile'
import TileState from 'ol/TileState'
import type { CountryBounds } from './country-bounds'

/** Free national orthophoto/satellite services that beat Esri World Imagery's
 *  resolution for their own country. Each entry's `bounds` restricts the
 *  layer's rendered extent so it only ever requests tiles inside the country
 *  — outside that box the map falls through to Esri. A handful require a
 *  free API key the user registers for themselves (see `apiKeys` below);
 *  those entries carry a `{apiKey}` placeholder in their `url` and are
 *  skipped (falling back to Esri) until a key is supplied. */
type XyzImagery = {
  kind: 'xyz'
  url: string
  /** `{s}` placeholder values for round-robin domain sharding (parallel tile
   *  downloads across subdomains), same idea as Leaflet's `subdomains`. */
  subdomains?: string[]
  maxNativeZoom: number
  minZoom?: number
  attribution: string
  bounds: CountryBounds
  /** Server paints a solid fill color (no alpha channel) outside its actual
   *  coverage instead of returning a transparent/no-data pixel — treat
   *  near-matches to this color as no-data client-side so Esri shows through
   *  the bbox's spillover into neighbouring territory. */
  chromaKeyColor?: [number, number, number]
}

type WmsImagery = {
  kind: 'wms'
  url: string
  layers: string
  format?: string
  maxZoom: number
  attribution: string
  bounds: CountryBounds
  /** Same opaque no-data spillover as the xyz entries' chromaKeyColor, for a
   *  WMS server that ignores `transparent=true` outside its real coverage. */
  chromaKeyColor?: [number, number, number]
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
    // Native tiles stop at 17; OL automatically upscales them for closer
    // view zooms (the maxNativeZoom trick), so no separate maxZoom is set.
    maxNativeZoom: 17,
    attribution: 'Datenquelle: <a href="https://basemap.at">basemap.at</a>',
    bounds: [[46.35877, 8.782379], [49.037872, 17.5]],
  },
  es: {
    kind: 'xyz',
    url: 'https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0&layer=OI.OrthoimageCoverage&style=default&format=image/jpeg&TileMatrixSet=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}',
    maxNativeZoom: 19,
    attribution: 'PNOA cedido por &copy; Instituto Geogr&aacute;fico Nacional de Espa&ntilde;a',
    // Same spillover as the fr bbox (this one reaches into the Atlantic,
    // Morocco and southern France), but PNOA only serves opaque jpeg, filling
    // outside its real Iberian coverage with a solid dark navy (rgb 32,26,38)
    // instead of white or transparent — chroma-key that color out instead.
    chromaKeyColor: [32, 26, 38],
    bounds: [[27.6, -18.4], [43.9, 4.4]],
  },
  cz: {
    kind: 'xyz',
    url: 'https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/{z}/{y}/{x}',
    maxNativeZoom: 19,
    attribution: '&copy; &Ccaron;&Uacute;ZK',
    bounds: [[48.55, 12.09], [51.06, 18.87]],
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
    // It also ignores transparent=true far from real Polish coverage — e.g.
    // over Czech territory, which the oversized bbox reaches — painting
    // solid opaque black there instead. Chroma-key that out like the fr/es
    // entries do for their own opaque no-data fills.
    chromaKeyColor: [0, 0, 0],
    bounds: [[48.9, 14.0], [54.93, 24.78]],
  },
  fr: {
    kind: 'xyz',
    url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER=HR.ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM_6_19&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg',
    minZoom: 6,
    maxNativeZoom: 19,
    attribution: '&copy; IGN-F/G&eacute;oportail',
    // Same spillover as the pl/dk bboxes (this one reaches into Belgium,
    // Luxembourg, Switzerland and northern Spain), but IGN only serves this
    // layer as opaque jpeg — GetTile with FORMAT=image/png 400s ("Format
    // image/png unknown") — so png+transparent isn't an option. Chroma-key
    // instead: IGN already clips to France's real border and fills outside
    // it solid white, so treating white as no-data recovers the same effect.
    chromaKeyColor: [255, 255, 255],
    bounds: [[41.3, -5.2], [51.1, 9.6]],
  },
  be: {
    kind: 'wms',
    url: 'https://wms.ngi.be/inspire/ortho/service',
    layers: 'orthoimage_coverage',
    format: 'image/png',
    maxZoom: 19,
    attribution: '&copy; NGI/IGN Belgium',
    bounds: [[49.435, 2.219], [51.889, 6.459]],
  },
  se: {
    kind: 'wms',
    url: 'https://minkarta.lantmateriet.se/map/ortofoto/',
    layers: 'Ortofoto_0.25',
    format: 'image/png',
    maxZoom: 19,
    attribution: '&copy; Lantm&auml;teriet',
    bounds: [[55.3, 11.0], [69.1, 24.2]],
  },
  // Requires a free, instant self-service key from
  // https://omatili.maanmittauslaitos.fi — skipped until CountryImageryKeys.fi
  // is set (see the mmlApiKey runtime config option).
  fi: {
    kind: 'xyz',
    url: 'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/ortokuva/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.jpg?api-key={apiKey}',
    maxNativeZoom: 18,
    attribution: '&copy; Maanmittauslaitos',
    bounds: [[59.6, 19.0], [70.1, 31.6]],
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
    bounds: [[54.5, 8.0], [57.8, 15.2]],
  },
}

export const COUNTRY_IMAGERY_CODES = Object.keys(COUNTRY_IMAGERY)

/** Free-tier API keys for the countries that need one. Missing/empty keys
 *  just make that country's layer skip itself — never an error. */
export type CountryImageryKeys = Partial<Record<string, string>>

// JPEG re-compresses the source's flat no-data fill with a bit of noise, so
// match nearby colors rather than requiring an exact hit.
const CHROMA_KEY_TOLERANCE = 10

/** A tileLoadFunction (shared by the XYZ and WMS sources below) that loads
 *  the tile off-DOM, makes near-`chromaKeyColor` pixels transparent on a
 *  scratch canvas, then assigns the result to the tile's own tracked <img> —
 *  OL's built-in load/error listener (already attached to that element) takes
 *  it from there, so this never needs to touch the tile's loaded state
 *  directly except on genuine failure. */
function chromaKeyLoader(chromaKeyColor: [number, number, number]) {
  const [kr, kg, kb] = chromaKeyColor
  return (tile: Tile, src: string): void => {
    const target = (tile as unknown as { getImage(): HTMLImageElement }).getImage()
    const loader = new Image()
    loader.crossOrigin = 'anonymous'
    loader.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = loader.naturalWidth
      canvas.height = loader.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(loader, 0, 0)
      try {
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const px = frame.data
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i] as number
          const g = px[i + 1] as number
          const b = px[i + 2] as number
          if (
            Math.abs(r - kr) <= CHROMA_KEY_TOLERANCE
            && Math.abs(g - kg) <= CHROMA_KEY_TOLERANCE
            && Math.abs(b - kb) <= CHROMA_KEY_TOLERANCE
          ) {
            px[i + 3] = 0
          }
        }
        ctx.putImageData(frame, 0, 0)
        target.src = canvas.toDataURL()
      } catch {
        // Canvas tainted (response missing CORS headers) — show the tile
        // un-keyed rather than not at all.
        target.src = src
      }
    }
    loader.onerror = () => {
      if (loader.crossOrigin) {
        // Some servers don't send CORS headers — retry without crossOrigin so
        // the tile still renders (opaque, un-keyed) instead of not at all.
        loader.removeAttribute('crossOrigin')
        loader.src = src
        return
      }
      tile.setState(TileState.ERROR)
    }
    loader.src = src
  }
}

function resolveUrl(config: CountryImagery, apiKeys: CountryImageryKeys, code: string): string | null {
  if (!config.url.includes('{apiKey}')) return config.url
  const key = apiKeys[code]
  if (!key) return null
  return config.url.replace('{apiKey}', encodeURIComponent(key))
}

/** Expands a `{s}` subdomain placeholder into OL's `urls` array (each
 *  subdomain gets its own full URL) — OL has no `{s}`/`subdomains` option
 *  of its own, this is the equivalent of Leaflet's round-robin sharding. */
function resolveUrls(url: string, subdomains: string[] | undefined): { url: string } | { urls: string[] } {
  if (!subdomains?.length) return { url }
  return { urls: subdomains.map((s) => url.replace('{s}', s)) }
}

function boundsToExtent(bounds: CountryBounds): Extent {
  const [[south, west], [north, east]] = bounds
  return transformExtent([west, south, east, north], 'EPSG:4326', 'EPSG:3857')
}

/** Builds a country's high-res imagery layer, or null when none is
 *  configured (or its required API key is missing) — caller should fall
 *  back to Esri in that case. */
export function createCountryImageryLayer(
  country: string | null | undefined,
  apiKeys: CountryImageryKeys = {},
): TileLayer<XYZ | TileWMS> | null {
  if (!country) return null
  const config = COUNTRY_IMAGERY[country]
  if (!config) return null
  const url = resolveUrl(config, apiKeys, country)
  if (url == null) return null
  const extent = boundsToExtent(config.bounds)
  const tileLoadFunction = config.chromaKeyColor ? chromaKeyLoader(config.chromaKeyColor) : undefined

  if (config.kind === 'wms') {
    const format = config.format ?? 'image/jpeg'
    return new TileLayer({
      extent,
      source: new TileWMS({
        url,
        params: {
          LAYERS: config.layers,
          FORMAT: format,
          // png entries chose png precisely because their bounds box
          // overlaps neighbouring countries — request transparent no-data
          // fill so the Esri layer underneath shows through there.
          TRANSPARENT: format === 'image/png',
        },
        attributions: config.attribution,
        crossOrigin: 'anonymous',
        tileLoadFunction,
      }),
    })
  }
  return new TileLayer({
    minZoom: config.minZoom,
    extent,
    source: new XYZ({
      ...resolveUrls(url, config.subdomains),
      maxZoom: config.maxNativeZoom,
      attributions: config.attribution,
      crossOrigin: 'anonymous',
      tileLoadFunction,
    }),
  })
}
