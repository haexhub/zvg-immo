import type OlMap from 'ol/Map'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import { useTourismGridLayer } from '~/composables/useTourismGridLayer'
import { useTourismVisitorLayer } from '~/composables/useTourismVisitorLayer'

/**
 * The search map's two tourism overlays (POI-density grid + NUTS2 visitor
 * intensity) for DetailMap.client.vue. Both layer composables were written
 * against vue3-openlayers component refs (`sourceRef.value.source`,
 * `layerRef.value.vectorLayer`); the detail map builds its OL tree
 * imperatively, so the layers are created here and handed over in that same
 * shape. `layers` goes into the map's constructor below the feature/hazard
 * overlays so their markers stay clickable on top of the choropleth.
 */
export function useDetailMapTourismLayers(options: { map: Ref<OlMap | null> }) {
  const grid = useTourismGridLayer({ map: options.map })
  const visitor = useTourismVisitorLayer()

  const gridLayer = new VectorLayer({ source: new VectorSource() })
  const visitorLayer = new VectorLayer({ source: new VectorSource() })
  grid.sourceRef.value = { source: gridLayer.getSource() }
  grid.layerRef.value = { vectorLayer: gridLayer }
  visitor.sourceRef.value = { source: visitorLayer.getSource() }
  visitor.layerRef.value = { vectorLayer: visitorLayer }

  // Mutually exclusive, same as on the search map — see Map.client.vue's
  // watch pair for why.
  watch(grid.category, (v) => { if (v != null) visitor.active.value = false })
  watch(visitor.active, (v) => { if (v) grid.category.value = null })

  return {
    layers: [gridLayer, visitorLayer],
    category: grid.category,
    categories: grid.categories,
    visitorActive: visitor.active,
    visitorBreaks: visitor.breaks,
    visitorAvailable: visitor.available,
  }
}
