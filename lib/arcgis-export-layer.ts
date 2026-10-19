import TileLayer from 'ol/layer/Tile'
import XYZ from 'ol/source/XYZ'
import { createXYZ } from 'ol/tilegrid'
import type { TileCoord } from 'ol/tilecoord'

// Esri's "export"/"exportImage" REST endpoints render a fresh image per
// request instead of serving a pre-rendered tile pyramid, so the tile's bbox
// has to be computed and passed as a query param on every request.
const arcGisTileGrid = createXYZ()

export function arcGisMapLayer(serviceUrl: string, layers: string, opacity: number, attribution: string): TileLayer<XYZ> {
  return arcGisGridLayer(serviceUrl, 'export', { layers }, opacity, attribution)
}

export function arcGisGridLayer(
  serviceUrl: string,
  operation: 'export' | 'exportImage',
  params: Record<string, string>,
  opacity: number,
  attribution: string,
): TileLayer<XYZ> {
  return new TileLayer({
    opacity,
    minZoom: 6,
    maxZoom: 18,
    source: new XYZ({
      tileGrid: arcGisTileGrid,
      attributions: attribution,
      crossOrigin: 'anonymous',
      tileUrlFunction: (tileCoord) => arcGisExportUrl(serviceUrl, tileCoord, operation, params),
    }),
  })
}

export function arcGisExportUrl(
  serviceUrl: string,
  tileCoord: TileCoord,
  operation: 'export' | 'exportImage',
  extraParams: Record<string, string> = {},
): string {
  const [minX, minY, maxX, maxY] = arcGisTileGrid.getTileCoordExtent(tileCoord)
  const url = new URL(`${serviceUrl.replace(/\/+$/, '')}/${operation}`)
  url.searchParams.set('bbox', `${minX},${minY},${maxX},${maxY}`)
  url.searchParams.set('bboxSR', '3857')
  url.searchParams.set('imageSR', '3857')
  url.searchParams.set('size', '256,256')
  url.searchParams.set('format', 'png32')
  url.searchParams.set('transparent', 'true')
  url.searchParams.set('f', 'image')
  for (const [key, value] of Object.entries(extraParams)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}
