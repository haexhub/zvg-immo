import GeoJSON from 'ol/format/GeoJSON'
import type { Feature } from 'ol'
import { Fill, Stroke, Style } from 'ol/style'
import { rgba } from '~/lib/auction-map-overlays'
import { tourismNutsBinColor } from '~/lib/tourism-nuts-categories'
import type { TourismVisitorDensityResponse } from '~/server/api/tourism-visitor-density.get'

// NUTS2 polygons are vastly larger than the POI-density grid's 10km cells —
// a fully opaque fill would blank out the basemap over large parts of a
// country, so this stays translucent regardless of bin (the hue/lightness
// step is what carries the magnitude signal here, not the alpha). Calibrated
// against the real imported dataset on both the OSM street and Esri
// satellite basemaps.
const FILL_ALPHA = 0.75
const STROKE_ALPHA = 0.9

const geoJsonFormat = new GeoJSON()
// Keyed by bin (0..TOURISM_NUTS_NUM_BINS-1, or 'null' for no-data) — at most
// a handful of distinct styles ever exist, same reasoning as
// useTourismGridLayer.ts's styleCache.
const styleCache = new Map<string, Style>()

/**
 * Search-map "Besucherintensität"-Ebene: the whole cached NUTS2 collection is
 * small (~242 regions, well under 1MB simplified) and changes at most a few
 * times a year, so unlike useTourismGridLayer.ts this fetches once on first
 * activation and keeps the parsed features around — no bbox/zoom-gated
 * moveend refetching.
 */
export function useTourismVisitorLayer() {
  const active = ref(false)
  const sourceRef = ref<any>(null)
  // vue3-openlayers' reactive `:style` prop on <ol-vector-layer> does not
  // reach the OL layer's actual style — it lands in the layer's generic
  // property bag via BaseObject.set('style', ...) (see useLayer.js's
  // updateLayers()), never through the layer's own setStyle() method, which
  // is the only thing ol/layer/BaseVector's renderer reads. The style must
  // be applied imperatively once this ref resolves — verified live against
  // the real imported dataset (a `:style` binding rendered nothing at any
  // alpha up to 1.0; layer.setStyle() via this ref rendered correctly).
  const layerRef = ref<any>(null)
  const loading = ref(false)
  const breaks = ref<number[]>([])
  // null = not checked yet (a transient network failure also leaves this
  // null rather than false, so it isn't mistaken for a confirmed "no data").
  const available = ref<boolean | null>(null)

  let cachedFeatures: Feature[] | null = null
  let loadPromise: Promise<void> | null = null

  function style(feature: any): Style {
    const bin = feature.get('bin') as number | null
    const color = tourismNutsBinColor(bin)
    const cacheKey = String(bin)
    let cached = styleCache.get(cacheKey)
    if (!cached) {
      cached = new Style({
        fill: new Fill({ color: rgba(color, FILL_ALPHA) }),
        stroke: new Stroke({ color: rgba(color, STROKE_ALPHA), width: 1 }),
      })
      styleCache.set(cacheKey, cached)
    }
    return cached
  }

  watch(layerRef, (layerComponent) => {
    layerComponent?.vectorLayer?.setStyle(style)
  }, { immediate: true })

  async function load(): Promise<void> {
    if (cachedFeatures) return
    if (loadPromise) return loadPromise
    loading.value = true
    loadPromise = (async () => {
      try {
        const response = await $fetch<TourismVisitorDensityResponse>('/api/tourism-visitor-density')
        available.value = response.available
        if (!response.available) {
          cachedFeatures = []
          return
        }
        breaks.value = response.breaks
        const collection = {
          type: 'FeatureCollection' as const,
          features: response.regions.map((region) => ({
            type: 'Feature' as const,
            geometry: region.geometry as any,
            properties: { bin: region.bin, name: region.name, value: region.value },
          })),
        }
        cachedFeatures = geoJsonFormat.readFeatures(collection, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }) as Feature[]
      } catch {
        // Leave cachedFeatures null so a later activation retries instead of
        // permanently treating a transient network error as "no data".
      } finally {
        loading.value = false
        loadPromise = null
      }
    })()
    return loadPromise
  }

  async function sync(): Promise<void> {
    const source = sourceRef.value?.source
    if (!source) return
    if (!active.value) {
      source.clear()
      return
    }
    await load()
    // Re-check after the await: the user may have deactivated the layer (or
    // the source may have been torn down/replaced) while load() was still
    // in flight — without this, a slow first activation that gets toggled
    // off before it resolves would still add features after the fact.
    if (!active.value || source !== sourceRef.value?.source) return
    source.clear()
    if (cachedFeatures?.length) source.addFeatures(cachedFeatures)
  }

  watch([active, () => sourceRef.value?.source], () => sync(), { immediate: true })

  // Checked eagerly (not gated on `active`) so the toggle can be hidden
  // before a user ever tries an unconfigured/never-imported layer, rather
  // than only after a click that visibly does nothing.
  void load()

  return { active, sourceRef, layerRef, loading, breaks, available }
}
