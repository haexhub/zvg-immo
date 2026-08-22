<script setup lang="ts">
import { Feature } from 'ol'
import { boundingExtent } from 'ol/extent'
import Point from 'ol/geom/Point'
import type OlMap from 'ol/Map'
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj'
import { Circle as CircleStyle, Fill, Icon, Stroke, Style, Text } from 'ol/style'
import type { GeoAuction } from '~/server/api/auctions-geo.get'
import type { AuctionSummary } from '~/server/api/auctions.get'
import LotPopover from '~/components/LotPopover.vue'
import { auctionKey } from '~/lib/auction-key'
import { boundsForCountries } from '~/lib/country-bounds'
import type { ContentTargetLang } from '~/lib/content-language'
import { OSM_ATTRIBUTION, mapTilerSatelliteStyleUrl, mapTilerStreetsStyleUrl } from '~/lib/map-tiles'
import { createMarkerClusterer, type ClusterPoint } from '~/lib/marker-clusterer'
import { mapPinDataUri, MAP_PIN_ANCHOR } from '~/lib/mapPinIcon'
import { useMapTilerVectorBaseLayer } from '~/composables/useMapTilerVectorBaseLayer'
import { useTourismGridLayer } from '~/composables/useTourismGridLayer'

const ESRI_IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const ESRI_LABELS_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
const ESRI_ATTRIBUTION = 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics'
const ESRI_LABELS_ATTRIBUTION = 'Tiles &copy; Esri'
// Only used before any auction data has loaded and no country is selected —
// once either is available, refreshMarkers()/fitFallbackView() below take
// over with a real fit (auction extent, or the selected country's bounds).
const EUROPE_CENTER_LONLAT: [number, number] = [15, 50]

const PIN_COLOR = '#2563eb'
const PIN_COLOR_ACTIVE = '#dc2626'
const pinStyleDefault = new Style({ image: new Icon({ src: mapPinDataUri(PIN_COLOR), anchor: MAP_PIN_ANCHOR }) })
const pinStyleActive = new Style({ image: new Icon({ src: mapPinDataUri(PIN_COLOR_ACTIVE), anchor: MAP_PIN_ANCHOR }) })

function pinStyle(active: boolean): Style {
  return active ? pinStyleActive : pinStyleDefault
}

// renderView() below builds one OL feature per cluster/point returned by the
// clusterer for the current viewport, tagging each with 'isCluster' (+
// 'count' for clusters) — so this single style function covers both
// individual pins and cluster badges. OL calls this for every visible
// feature on every render pass (pan/zoom/refresh), so cluster badge styles
// are cached like the singleton pin styles above instead of rebuilt each time.
const clusterStyleCache = new Map<string, Style>()
function clusterStyle(feature: any): Style {
  if (!feature.get('isCluster')) {
    return pinStyle(feature.get('active') === true)
  }
  const count = feature.get('count') as number
  const active = feature.get('active') === true
  const cacheKey = `${count}:${active}`
  let style = clusterStyleCache.get(cacheKey)
  if (!style) {
    const color = active ? PIN_COLOR_ACTIVE : PIN_COLOR
    style = new Style({
      image: new CircleStyle({ radius: 18, fill: new Fill({ color }), stroke: new Stroke({ color: '#fff', width: 2 }) }),
      text: new Text({ text: String(count), fill: new Fill({ color: '#fff' }), font: 'bold 12px sans-serif' }),
    })
    clusterStyleCache.set(cacheKey, style)
  }
  return style
}

const props = defineProps<{
  auctions: GeoAuction[]
  /** Summaries for the auctions the search grid currently has loaded, keyed by
   *  `auctionKey()` — lets the popover skip its fallback fetch when the
   *  clicked marker is among them. */
  auctionSummaries?: Map<string, AuctionSummary>
  selectedCountries?: string[]
  activeAuctionKey?: string | null
  /** Bumping this string requests a re-fit on the next marker refresh — used
   *  by the parent so country/region changes recenter the map, while polling
   *  updates leave the user's current zoom/pan alone. */
  fitKey?: string
  /** Restores a previously shared/URL-synced viewport instead of the default
   *  auto-fit-to-auctions on first mount. */
  initialView?: { lat: number; lng: number; zoom: number } | null
}>()

const emit = defineEmits<{
  /** Current visible viewport (fired on moveend and after every programmatic
   *  fit). The parent uses it to restrict the result list to the map area
   *  when the "Kartenbereich" filter is on. */
  (e: 'bounds-change', bounds: { north: number; south: number; east: number; west: number }): void
  /** Same trigger points as bounds-change — lets the parent mirror center/zoom
   *  into the URL so a shared link/back-navigation reproduces this viewport. */
  (e: 'view-change', view: { lat: number; lng: number; zoom: number }): void
  (e: 'auction-hover', key: string | null): void
  (e: 'auction-select', key: string): void
}>()

const { locale, t } = useI18n()
const runtimeConfig = useRuntimeConfig()
const mapTilerApiKey = computed(() => String(runtimeConfig.public.maptilerApiKey || '').trim())

// Only 'de'/'en' have LLM translation support (see lib/content-language.ts);
// any other UI locale falls back to showing the auction's original title.
function resolveContentLang(loc: string): ContentTargetLang | null {
  return loc === 'de' || loc === 'en' ? loc : null
}
const contentLang = computed(() => resolveContentLang(locale.value))

const baseLayer = ref<'streets' | 'satellite'>('streets')
const initialCenter = props.initialView
  ? fromLonLat([props.initialView.lng, props.initialView.lat])
  : fromLonLat(EUROPE_CENTER_LONLAT)
const initialZoom = props.initialView?.zoom ?? 4

// The MapTiler base layer renders as vector tiles (see
// useMapTilerVectorBaseLayer) with labels re-localized to the UI locale — one
// style per mode covers every language, unlike raster tiles which bake the
// label language into the style. No key configured -> empty URL -> the
// composable stays inert and the raster OSM/Esri fallback below renders
// instead.
const vectorStyleUrl = computed(() => {
  if (!mapTilerApiKey.value) return ''
  return baseLayer.value === 'streets'
    ? mapTilerStreetsStyleUrl(mapTilerApiKey.value, String(runtimeConfig.public.maptilerStreetsMapId || '') || undefined)
    : mapTilerSatelliteStyleUrl(mapTilerApiKey.value, String(runtimeConfig.public.maptilerSatelliteMapId || '') || undefined)
})

const mapRef = ref<any>(null)
// Must not be named `olMap`: the template compiler camelizes the `<ol-map>`
// tag to `olMap` and prefers a same-named setup binding over
// resolveComponent(), so that binding would render as the component itself —
// see the guard in Map.client.test.ts.
const mapInstance = shallowRef<OlMap | null>(null)
watch(() => mapRef.value?.map, (m) => { mapInstance.value = m ?? null }, { immediate: true })
useMapTilerVectorBaseLayer({ map: mapInstance, styleUrl: vectorStyleUrl, lang: locale })
const vectorSourceRef = ref<any>(null)
const vectorLayerRef = ref<any>(null)

const {
  category: tourismCategory,
  categories: tourismCategories,
  sourceRef: tourismSourceRef,
  style: tourismLayerStyle,
} = useTourismGridLayer({ map: mapInstance })

const MAX_ZOOM = 18

// Supercluster instead of ol/source/Cluster: the latter recomputes its
// entire feature set from scratch on every 'change' event (see the old
// addFeatures()/removeFeatures() batching comments this replaced), which
// cost ~5s of blocked main thread for a few thousand markers — see
// search-map-freeze-cluster-investigation memory. Supercluster indexes once
// per data change (a few ms even at MAX_MARKERS) and answers per-viewport
// queries in well under a millisecond.
const clusterer = createMarkerClusterer(60)

const selectedKey = ref<string | null>(null)
const popupPosition = ref<number[] | undefined>(undefined)
const selectedAuction = computed<GeoAuction | undefined>(() => {
  if (!selectedKey.value) return undefined
  return auctionsByKey.get(selectedKey.value)
})
const selectedSummary = computed<AuctionSummary | null>(() => {
  if (!selectedKey.value) return null
  return props.auctionSummaries?.get(selectedKey.value) ?? null
})

// Set instead of opening a popup when a cluster can't be split further by
// zooming (see onMapClick) — lets the user pick one of the co-located
// auctions individually rather than being stuck with an unclickable badge.
const clusterKeys = ref<string[] | null>(null)
const clusterAuctions = computed<GeoAuction[]>(() => {
  if (!clusterKeys.value) return []
  return clusterKeys.value
    .map((key) => auctionsByKey.get(key))
    .filter((a): a is GeoAuction => a != null)
})

// True at mount (unless a restored initialView takes precedence) and whenever
// the parent bumps `fitKey` (filter change). The next refreshMarkers call
// consumes it, so polling-driven updates never reset the user's zoom/pan.
let shouldFitNext = !props.initialView
let fallbackFitKey: string | null = null

// Full auction data keyed by `platform:externalId` — renderView() below only
// ever builds features for the clusters/points visible in the current
// viewport, so this (not the map's vector source) is the lookup the popup/
// cluster-picker/computeds above read from.
const auctionsByKey = new Map<string, GeoAuction>()

function emitBounds(): void {
  const map = mapRef.value?.map
  if (!map) return
  const size = map.getSize()
  if (!size) return
  const extent = map.getView().calculateExtent(size)
  const [west, south, east, north] = transformExtent(extent, 'EPSG:3857', 'EPSG:4326') as [number, number, number, number]
  emit('bounds-change', { north, south, east, west })
}

function emitViewState(): void {
  const view = mapRef.value?.map?.getView()
  const center = view?.getCenter()
  const zoom = view?.getZoom()
  if (!center || zoom == null) return
  const [lng, lat] = toLonLat(center) as [number, number]
  emit('view-change', { lat, lng, zoom })
}

function fitFallbackView(): void {
  const map = mapRef.value?.map
  if (!map) return
  const view = map.getView()
  const bounds = boundsForCountries(props.selectedCountries ?? [])
  if (bounds) {
    const [[south, west], [north, east]] = bounds
    const extent = transformExtent([west, south, east, north], 'EPSG:4326', 'EPSG:3857')
    view.fit(extent, { padding: [28, 28, 28, 28] })
  } else {
    view.setCenter(initialCenter)
    view.setZoom(initialZoom)
  }
}

function fitToAuctions(map: OlMap, points: ClusterPoint[]): void {
  const coords = points.map((p) => fromLonLat([p.lng, p.lat]))
  map.getView().fit(boundingExtent(coords), { padding: [40, 40, 40, 40], maxZoom: 12 })
}

// Rebuilds the vector source from whatever the clusterer returns for the
// current viewport + zoom — called after refreshMarkers() re-indexes the
// data, and again on every moveend/activeAuctionKey change so pan/zoom and
// hover highlighting stay in sync without re-indexing. clear()+addFeatures()
// fires one 'change' event for the whole batch, same reasoning as the
// addFeatures()/removeFeatures() batching this replaced.
function renderView(): void {
  const source = vectorSourceRef.value?.source
  const map = mapRef.value?.map
  const size = map?.getSize()
  if (!source || !map || !size) return

  const extent = map.getView().calculateExtent(size)
  const bbox = transformExtent(extent, 'EPSG:3857', 'EPSG:4326') as [number, number, number, number]
  const zoom = map.getView().getZoom() ?? initialZoom
  const activeKey = props.activeAuctionKey ?? null

  const features = clusterer.getClusters(bbox, zoom).map((c) => {
    const feature = new Feature({ geometry: new Point(fromLonLat([c.lng, c.lat])) })
    if (c.isCluster) {
      feature.setId(`cluster:${c.clusterId}`)
      feature.set('isCluster', true)
      feature.set('clusterId', c.clusterId)
      feature.set('count', c.count)
      // A cluster reads as "active" if the hovered/selected auction happens
      // to be one of its (currently uncollapsed) children — getLeafKeys()
      // only runs for the handful of clusters actually on screen, and only
      // once activeKey is set at all, so this stays cheap.
      feature.set('active', activeKey != null && clusterer.getLeafKeys(c.clusterId).includes(activeKey))
    } else {
      feature.setId(c.key)
      feature.set('isCluster', false)
      feature.set('key', c.key)
      feature.set('active', c.key === activeKey)
    }
    return feature
  })
  source.clear()
  source.addFeatures(features)
}

function refreshMarkers(): void {
  const map = mapRef.value?.map
  if (!vectorSourceRef.value?.source || !map) return

  auctionsByKey.clear()
  const points: ClusterPoint[] = []
  for (const a of props.auctions) {
    if (a.lat == null || a.lng == null) continue
    const key = auctionKey(a)
    auctionsByKey.set(key, a)
    points.push({ key, lng: a.lng, lat: a.lat })
  }
  clusterer.load(points)

  // Close an open popup/picker pointing at an auction that dropped out (e.g.
  // narrowing from "all countries" to one region drops thousands at once).
  if (selectedKey.value && !auctionsByKey.has(selectedKey.value)) {
    selectedKey.value = null
    popupPosition.value = undefined
  }
  if (clusterKeys.value) {
    const remaining = clusterKeys.value.filter((k) => auctionsByKey.has(k))
    if (remaining.length !== clusterKeys.value.length) {
      clusterKeys.value = remaining.length ? remaining : null
      if (!remaining.length) popupPosition.value = undefined
    }
  }

  const currentFitKey = props.fitKey ?? ''
  const canUpgradeFallbackFit = fallbackFitKey === currentFitKey && points.length > 0
  if (shouldFitNext || canUpgradeFallbackFit) {
    shouldFitNext = false
    if (points.length) {
      fallbackFitKey = null
      fitToAuctions(map, points)
    } else {
      fallbackFitKey = currentFitKey
      fitFallbackView()
    }
  }

  renderView()
}

function onMoveEnd(): void {
  emitBounds()
  emitViewState()
  renderView()
}

// vue3-openlayers creates the underlying ol/source/Vector asynchronously
// (after the map/layer hierarchy above it is ready), so onMounted alone
// would race it — wait for the exposed ref to actually resolve instead. Its
// defineExpose'd refs are already unwrapped by Vue's proxyRefs at the
// component-ref boundary, so `.source` is the raw VectorSource, not a Ref.
watch(
  () => vectorSourceRef.value?.source,
  (source) => {
    if (!source) return
    refreshMarkers()
    emitBounds()
    emitViewState()
  },
  { immediate: true },
)

watch(() => props.fitKey, () => {
  shouldFitNext = true
  fallbackFitKey = null
  refreshMarkers()
})

watch(() => props.auctions, refreshMarkers, { deep: false })
watch(() => props.activeAuctionKey, renderView)

// Without this, forEachFeatureAtPixel below also hits the MapTiler vector
// base layer's own features (road/landcover/water polygons cover almost
// every pixel) once useMapTilerVectorBaseLayer is active — clicking empty
// map area then finds one of those instead of nothing, and a foreign
// feature has neither 'isCluster' nor 'key' set, which would otherwise
// select `undefined` instead of running the popup-closing reset below. Only
// the raster OSM/Esri fallback (no vector features) hid this.
function isMarkerLayer(layer: any): boolean {
  return layer === vectorLayerRef.value?.vectorLayer
}

function onMapClick(evt: any): void {
  const map = mapRef.value?.map
  if (!map) return
  const feature = map.forEachFeatureAtPixel(evt.pixel, (f: any) => f, { layerFilter: isMarkerLayer })
  if (!feature) {
    selectedKey.value = null
    clusterKeys.value = null
    popupPosition.value = undefined
    return
  }
  if (feature.get('isCluster')) {
    const clusterId = feature.get('clusterId') as number
    const view = map.getView()
    // Supercluster reports the zoom at which this specific cluster actually
    // splits — a value beyond MAX_ZOOM means it never will (e.g. several
    // auctions unresolvable to an exact address and parked at the same
    // country-centroid fallback: every child sits at the exact same
    // coordinate, see marker-clusterer.test.ts). Same once the view is
    // already at max zoom: further "zoom in" would be a no-op animation,
    // leaving the cluster permanently unclickable. Offer a picker instead of
    // spinning forever.
    const expansionZoom = clusterer.getExpansionZoom(clusterId)
    const atMaxZoom = (view.getZoom() ?? initialZoom) >= MAX_ZOOM
    if (expansionZoom > MAX_ZOOM || atMaxZoom) {
      selectedKey.value = null
      clusterKeys.value = clusterer.getLeafKeys(clusterId)
      popupPosition.value = feature.getGeometry().getCoordinates()
      return
    }
    // Cluster of more than one, still spatially separable — zoom in instead
    // of opening a popup, same as the implicit cluster-click-to-expand
    // behaviour of the Leaflet version.
    view.animate({ center: feature.getGeometry().getCoordinates(), zoom: Math.min(expansionZoom, MAX_ZOOM) })
    return
  }
  clusterKeys.value = null
  const key = feature.get('key') as string
  selectedKey.value = key
  popupPosition.value = feature.getGeometry().getCoordinates()
  emit('auction-select', key)
}

function selectFromCluster(auction: GeoAuction): void {
  const key = auctionKey(auction)
  clusterKeys.value = null
  selectedKey.value = key
  emit('auction-select', key)
}

let lastHoverKey: string | null = null
function onPointerMove(evt: any): void {
  const map = mapRef.value?.map
  if (!map) return
  const feature = map.forEachFeatureAtPixel(evt.pixel, (f: any) => f, { layerFilter: isMarkerLayer })
  const key = feature && !feature.get('isCluster') ? (feature.get('key') as string) : null
  if (key === lastHoverKey) return
  lastHoverKey = key
  emit('auction-hover', key)
}
</script>

<template>
  <div class="relative isolate h-full w-full rounded-xl border shadow-sm overflow-hidden">
    <!-- OL's own click/drag threshold defaults to 1px (moveTolerance), so any
         real-world mouse/trackpad click that drifts by 2px+ between press and
         release gets reclassified as a pan and never fires 'click' at all —
         onMapClick then never runs, and an open popup can't be dismissed by
         clicking elsewhere. 8px keeps that dismiss-click reliable without
         interfering with genuine drags. -->
    <ol-map ref="mapRef" class="h-full w-full" :move-tolerance="8" @click="onMapClick" @pointermove="onPointerMove" @moveend="onMoveEnd">
      <ol-view :center="initialCenter" :zoom="initialZoom" projection="EPSG:3857" />
      <!-- MapTiler vector base layer (useMapTilerVectorBaseLayer) is inserted
           imperatively at the bottom of the layer stack once a key is
           configured; this raster fallback only renders without one. -->
      <template v-if="!mapTilerApiKey">
        <ol-tile-layer v-if="baseLayer === 'streets'">
          <ol-source-osm :attributions="OSM_ATTRIBUTION" />
        </ol-tile-layer>
        <template v-else>
          <ol-tile-layer>
            <ol-source-xyz :url="ESRI_IMAGERY_URL" :attributions="ESRI_ATTRIBUTION" />
          </ol-tile-layer>
          <ol-tile-layer>
            <ol-source-xyz :url="ESRI_LABELS_URL" :attributions="ESRI_LABELS_ATTRIBUTION" />
          </ol-tile-layer>
        </template>
      </template>
      <!-- Tourism-intensity choropleth, below the marker layer so pins/
           clusters stay clickable and legible on top of it. -->
      <ol-vector-layer :style="tourismLayerStyle">
        <ol-source-vector ref="tourismSourceRef" />
      </ol-vector-layer>
      <ol-vector-layer ref="vectorLayerRef" :style="clusterStyle">
        <ol-source-vector ref="vectorSourceRef" />
      </ol-vector-layer>
      <ol-overlay
        v-if="selectedKey && popupPosition"
        :position="popupPosition"
        :offset="[0, -12]"
        positioning="bottom-center"
        :auto-pan="{ margin: 20 }"
      >
        <div class="min-w-[280px] max-w-[320px] rounded-lg bg-white p-1 shadow-lg">
          <!-- Keyed on the auction: clicking a second marker while a popup is
               open swaps selectedKey without ever unmounting the overlay, so
               without this the instance would keep the previous auction's
               fetched summary, photos and translated title. -->
          <LotPopover
            v-if="selectedAuction"
            :key="selectedKey!"
            :auction="selectedAuction"
            :summary="selectedSummary"
            :lang="contentLang"
          />
        </div>
      </ol-overlay>
      <ol-overlay
        v-if="clusterKeys && popupPosition"
        :position="popupPosition"
        :offset="[0, -12]"
        positioning="bottom-center"
        :auto-pan="{ margin: 20 }"
      >
        <div class="flex max-h-60 min-w-[220px] max-w-[280px] flex-col gap-0.5 overflow-y-auto rounded-lg bg-white p-2 text-gray-900 shadow-lg">
          <div class="mb-1 text-[11px] font-semibold uppercase text-gray-500">{{ t('map.clusterPickerHint', { count: clusterAuctions.length }) }}</div>
          <button
            v-for="a in clusterAuctions"
            :key="auctionKey(a)"
            type="button"
            class="cursor-pointer rounded-md bg-transparent px-2 py-1.5 text-left text-[13px] leading-[1.35] text-gray-900 hover:bg-gray-100 focus-visible:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600"
            @click="selectFromCluster(a)"
          >
            {{ a.country.toUpperCase() }} · {{ a.region }} · {{ a.externalId }}
          </button>
        </div>
      </ol-overlay>
    </ol-map>
    <AuctionMapBaseLayerToggle v-model="baseLayer" />
    <AuctionTourismLegend v-model:category="tourismCategory" :categories="tourismCategories" />
  </div>
</template>
