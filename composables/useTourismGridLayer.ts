import GeoJSON from 'ol/format/GeoJSON'
import type OlMap from 'ol/Map'
import { transformExtent } from 'ol/proj'
import { Fill, Stroke, Style } from 'ol/style'
import { rgba } from '~/lib/auction-map-overlays'
import {
  TOURISM_GRID_CATEGORIES,
  tourismGridCategory,
  tourismIntensityAlpha,
  type TourismCategory,
} from '~/lib/tourism-grid-categories'
import type { TourismGridResponse } from '~/server/api/tourism-grid.get'

// Grid cells are 10km — imperceptible (and needlessly expensive to fetch) at
// a continent-wide zoom, so the layer simply stays empty below this zoom
// instead of fetching thousands of cells nobody can see individually.
const MIN_ZOOM_TO_FETCH = 6
const REFRESH_DEBOUNCE_MS = 300

const geoJsonFormat = new GeoJSON()
// One Style instance per (category, alpha) combination — at most 5 buckets
// times 1 active category at a time (see lib/tourism-grid-categories.ts on
// why only one category ever renders at once), same reasoning as
// Map.client.vue's clusterStyleCache: OL calls the style function per visible
// feature on every render pass.
const styleCache = new Map<string, Style>()

/**
 * Search-map "Tourismus-Layer": fetches the bbox-scoped tourism grid for
 * whichever single category is currently selected and keeps an OL vector
 * source in sync with it. `map` is Map.client.vue's raw `ol/Map` instance
 * (not a template ref) — this composable doesn't own the `<ol-map>` tree
 * itself, so it observes viewport changes via the map's native event
 * emitter instead of a template `@moveend` handler.
 */
export function useTourismGridLayer(options: { map: Ref<OlMap | null> }) {
  const { map } = options
  const category = ref<TourismCategory | null>(null)
  const sourceRef = ref<any>(null)
  // vue3-openlayers' reactive `:style` prop on <ol-vector-layer> does not
  // reach the OL layer's actual style — see
  // useTourismVisitorLayer.ts's layerRef comment for the full root cause.
  // The style must be applied imperatively once this ref resolves; the
  // style function itself still reads `category`/`feature` fresh on every
  // call, so a single setStyle() here is enough — no need to re-apply it
  // when the category changes.
  const layerRef = ref<any>(null)
  const loading = ref(false)

  function style(feature: any): Style {
    const activeCategory = category.value
    const categoryDef = activeCategory ? tourismGridCategory(activeCategory) : undefined
    if (!categoryDef) return new Style()
    const alpha = tourismIntensityAlpha(feature.get('count') as number)
    const cacheKey = `${categoryDef.category}:${alpha}`
    let cached = styleCache.get(cacheKey)
    if (!cached) {
      cached = new Style({
        fill: new Fill({ color: rgba(categoryDef.color, alpha) }),
        stroke: new Stroke({ color: rgba(categoryDef.color, Math.min(alpha + 0.15, 0.95)), width: 1 }),
      })
      styleCache.set(cacheKey, cached)
    }
    return cached
  }

  watch(layerRef, (layerComponent) => {
    layerComponent?.vectorLayer?.setStyle(style)
  }, { immediate: true })

  let requestId = 0
  let loadedCategory: TourismCategory | null = null
  async function refresh(): Promise<void> {
    // Bump before every early return too — otherwise a request still in
    // flight when the layer gets deactivated/zoomed-out can later land and
    // restore cells the user just asked to clear.
    const id = ++requestId
    const source = sourceRef.value?.source
    if (!source) return

    const m = map.value
    const cat = category.value
    const zoom = m?.getView().getZoom() ?? 0
    if (!m || !cat || zoom < MIN_ZOOM_TO_FETCH) {
      source.clear()
      loadedCategory = null
      loading.value = false
      return
    }

    const size = m.getSize()
    if (!size) return

    if (loadedCategory !== cat) source.clear()

    const extent = m.getView().calculateExtent(size)
    const [west, south, east, north] = transformExtent(extent, 'EPSG:3857', 'EPSG:4326') as [number, number, number, number]

    loading.value = true
    try {
      const response = await $fetch<TourismGridResponse>('/api/tourism-grid', {
        query: { category: cat, north, south, east, west },
      })
      if (id !== requestId) return // superseded by a newer request (pan/zoom/category change)
      const collection = {
        type: 'FeatureCollection' as const,
        features: response.cells.map((cell) => ({
          type: 'Feature' as const,
          geometry: cell.geometry as any,
          properties: { count: cell.count },
        })),
      }
      const features = geoJsonFormat.readFeatures(collection, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' })
      source.clear()
      source.addFeatures(features)
      loadedCategory = cat
    } catch {
      // Network hiccup — leave whatever previously rendered in place rather
      // than blanking the layer, but only when it's still showing the same
      // category; a failed refresh right after a category switch must not
      // leave the old category's cells under the new category's color.
      if (loadedCategory !== cat) source.clear()
    } finally {
      if (id === requestId) loading.value = false
    }
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  function scheduleRefresh(): void {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS)
  }

  watch(map, (m, _prev, onCleanup) => {
    if (!m) return
    m.on('moveend', scheduleRefresh)
    onCleanup(() => m.un('moveend', scheduleRefresh))
  }, { immediate: true })

  // Category toggles and the source becoming ready both need an immediate
  // (non-debounced) refresh — debouncing only exists to smooth out
  // rapid-fire pan/zoom moveend events above.
  watch([category, () => sourceRef.value?.source], () => refresh(), { immediate: true })

  return { category, categories: TOURISM_GRID_CATEGORIES, sourceRef, layerRef, loading }
}
