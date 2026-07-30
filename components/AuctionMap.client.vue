<script setup lang="ts">
import { Feature } from 'ol'
import Point from 'ol/geom/Point'
import { fromLonLat, transformExtent } from 'ol/proj'
import { Circle as CircleStyle, Fill, Icon, Stroke, Style, Text } from 'ol/style'
import type { GeoAuction } from '~/server/api/auctions-geo.get'
import LotPopover from '~/components/LotPopover.vue'
import { auctionKey } from '~/lib/auction-key'
import { boundsForCountries } from '~/lib/country-bounds'
import type { ContentTargetLang } from '~/lib/content-language'
import { MAPTILER_ATTRIBUTION, OSM_ATTRIBUTION, mapTilerSatelliteUrl, mapTilerStreetsUrl } from '~/lib/map-tiles'
import { mapPinDataUri, MAP_PIN_ANCHOR } from '~/lib/mapPinIcon'

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

// ol/source/Cluster wraps every feature (even singletons) in a "cluster
// feature" whose `features` property holds the real children — so this
// single style function covers both individual pins and cluster badges.
function clusterStyle(feature: any): Style {
  const children = (feature.get('features') ?? [feature]) as Feature<Point>[]
  if (children.length === 1) {
    return pinStyle(children[0]!.get('active') === true)
  }
  const active = children.some((f) => f.get('active') === true)
  const color = active ? PIN_COLOR_ACTIVE : PIN_COLOR
  return new Style({
    image: new CircleStyle({ radius: 18, fill: new Fill({ color }), stroke: new Stroke({ color: '#fff', width: 2 }) }),
    text: new Text({ text: String(children.length), fill: new Fill({ color: '#fff' }), font: 'bold 12px sans-serif' }),
  })
}

const props = defineProps<{
  auctions: GeoAuction[]
  selectedCountries?: string[]
  activeAuctionKey?: string | null
  /** Bumping this string requests a re-fit on the next marker refresh — used
   *  by the parent so country/region changes recenter the map, while polling
   *  updates leave the user's current zoom/pan alone. */
  fitKey?: string
}>()

const emit = defineEmits<{
  /** Current visible viewport (fired on moveend and after every programmatic
   *  fit). The parent uses it to restrict the result list to the map area
   *  when the "Kartenbereich" filter is on. */
  (e: 'bounds-change', bounds: { north: number; south: number; east: number; west: number }): void
  (e: 'auction-hover', key: string | null): void
  (e: 'auction-select', key: string): void
}>()

const { locale, t } = useI18n()
const runtimeConfig = useRuntimeConfig()
const mapTilerApiKey = computed(() => String(runtimeConfig.public.mapTilerApiKey || '').trim())
const streetsTileUrl = computed(() => mapTilerApiKey.value ? mapTilerStreetsUrl(locale.value, mapTilerApiKey.value) : '')
const satelliteTileUrl = computed(() => mapTilerApiKey.value ? mapTilerSatelliteUrl(locale.value, mapTilerApiKey.value) : '')

// Only 'de'/'en' have LLM translation support (see lib/content-language.ts);
// any other UI locale falls back to showing the auction's original title.
function resolveContentLang(loc: string): ContentTargetLang | null {
  return loc === 'de' || loc === 'en' ? loc : null
}
const contentLang = computed(() => resolveContentLang(locale.value))

const baseLayer = ref<'streets' | 'satellite'>('streets')
const initialCenter = fromLonLat(EUROPE_CENTER_LONLAT)
const initialZoom = 4

const mapRef = ref<any>(null)
const vectorSourceRef = ref<any>(null)
const clusterSourceRef = ref<any>(null)

const selectedKey = ref<string | null>(null)
const popupPosition = ref<number[] | undefined>(undefined)
const selectedAuction = computed<GeoAuction | undefined>(() => {
  if (!selectedKey.value) return undefined
  return featuresByKey.get(selectedKey.value)?.get('auction') as GeoAuction | undefined
})

// True at mount and whenever the parent bumps `fitKey` (filter change). The
// next refreshMarkers call consumes it, so polling-driven updates never reset
// the user's zoom/pan.
let shouldFitNext = true
let fallbackFitKey: string | null = null

// Features keyed by `platform:externalId` so refreshMarkers can diff instead
// of rebuilding — existing features (and an open popup) survive poll updates.
const featuresByKey = new Map<string, Feature<Point>>()
let lastActiveKey: string | null = null

function updateMarkerHighlight(): void {
  const changedKeys = new Set([lastActiveKey, props.activeAuctionKey].filter((key): key is string => key != null))
  for (const key of changedKeys) {
    const feature = featuresByKey.get(key)
    if (!feature) continue
    feature.set('active', key === props.activeAuctionKey)
  }
  lastActiveKey = props.activeAuctionKey ?? null
  // Mirrors markersLayer.refreshClusters(changedMarkers) from the Leaflet
  // version — forces the cluster layer to re-run the style function.
  if (changedKeys.size) clusterSourceRef.value?.source?.refresh()
}

function emitBounds(): void {
  const map = mapRef.value?.map
  if (!map) return
  const size = map.getSize()
  if (!size) return
  const extent = map.getView().calculateExtent(size)
  const [west, south, east, north] = transformExtent(extent, 'EPSG:3857', 'EPSG:4326') as [number, number, number, number]
  emit('bounds-change', { north, south, east, west })
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

function refreshMarkers(): void {
  const source = vectorSourceRef.value?.source
  const map = mapRef.value?.map
  if (!source || !map) return

  const seen = new Set<string>()
  let hasPoints = false
  for (const a of props.auctions) {
    if (a.lat == null || a.lng == null) continue
    const key = auctionKey(a)
    seen.add(key)
    hasPoints = true
    let feature = featuresByKey.get(key)
    if (!feature) {
      feature = new Feature({ geometry: new Point(fromLonLat([a.lng, a.lat])) })
      feature.setId(key)
      feature.set('active', key === props.activeAuctionKey)
      if (key === props.activeAuctionKey) lastActiveKey = key
      featuresByKey.set(key, feature)
      source.addFeature(feature)
    }
    // Refreshed on every pass (not just on creation) so a popup opened after
    // a later poll shows live data instead of the auction as it was when the
    // marker was first created.
    feature.set('auction', a)
  }
  // Remove features whose auctions dropped out; close an open popup pointing
  // at a removed feature.
  for (const [key, feature] of featuresByKey) {
    if (seen.has(key)) continue
    source.removeFeature(feature)
    featuresByKey.delete(key)
    if (selectedKey.value === key) {
      selectedKey.value = null
      popupPosition.value = undefined
    }
  }

  const currentFitKey = props.fitKey ?? ''
  const canUpgradeFallbackFit = fallbackFitKey === currentFitKey && hasPoints
  if (!shouldFitNext && !canUpgradeFallbackFit) return
  if (hasPoints) {
    shouldFitNext = false
    fallbackFitKey = null
    map.getView().fit(source.getExtent(), { padding: [40, 40, 40, 40], maxZoom: 12 })
  } else {
    shouldFitNext = false
    fallbackFitKey = currentFitKey
    fitFallbackView()
  }
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
  },
  { immediate: true },
)

watch(() => props.fitKey, () => {
  shouldFitNext = true
  fallbackFitKey = null
  refreshMarkers()
})

watch(() => props.auctions, refreshMarkers, { deep: false })
watch(() => props.activeAuctionKey, updateMarkerHighlight)

function onMapClick(evt: any): void {
  const map = mapRef.value?.map
  if (!map) return
  const clusterFeature = map.forEachFeatureAtPixel(evt.pixel, (f: any) => f)
  if (!clusterFeature) {
    selectedKey.value = null
    popupPosition.value = undefined
    return
  }
  const children = clusterFeature.get('features') as Feature<Point>[]
  if (children.length > 1) {
    // Cluster of more than one — zoom in instead of opening a popup, same as
    // the implicit cluster-click-to-expand behaviour of the Leaflet version.
    const view = map.getView()
    view.animate({ center: clusterFeature.getGeometry().getCoordinates(), zoom: Math.min((view.getZoom() ?? initialZoom) + 2, 18) })
    return
  }
  const key = children[0]!.getId() as string
  selectedKey.value = key
  popupPosition.value = clusterFeature.getGeometry().getCoordinates()
  emit('auction-select', key)
}

let lastHoverKey: string | null = null
function onPointerMove(evt: any): void {
  const map = mapRef.value?.map
  if (!map) return
  const clusterFeature = map.forEachFeatureAtPixel(evt.pixel, (f: any) => f)
  const children = clusterFeature?.get('features') as Feature<Point>[] | undefined
  const key = children && children.length === 1 ? (children[0]!.getId() as string) : null
  if (key === lastHoverKey) return
  lastHoverKey = key
  emit('auction-hover', key)
}
</script>

<template>
  <div class="relative isolate h-full w-full rounded-xl border shadow-sm overflow-hidden">
    <ol-map ref="mapRef" class="h-full w-full" @click="onMapClick" @pointermove="onPointerMove" @moveend="emitBounds">
      <ol-view :center="initialCenter" :zoom="initialZoom" projection="EPSG:3857" />
      <ol-tile-layer v-if="baseLayer === 'streets'">
        <ol-source-xyz v-if="streetsTileUrl" :url="streetsTileUrl" :attributions="MAPTILER_ATTRIBUTION" />
        <ol-source-osm v-else :attributions="OSM_ATTRIBUTION" />
      </ol-tile-layer>
      <template v-else>
        <ol-tile-layer v-if="satelliteTileUrl">
          <ol-source-xyz :url="satelliteTileUrl" :attributions="MAPTILER_ATTRIBUTION" />
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
      <ol-vector-layer :style="clusterStyle">
        <ol-source-cluster ref="clusterSourceRef" :distance="60">
          <ol-source-vector ref="vectorSourceRef" />
        </ol-source-cluster>
      </ol-vector-layer>
      <ol-overlay v-if="selectedKey && popupPosition" :position="popupPosition" :offset="[0, -12]" positioning="bottom-center">
        <div class="auction-map-popup">
          <LotPopover v-if="selectedAuction" :auction="selectedAuction" :lang="contentLang" />
        </div>
      </ol-overlay>
    </ol-map>
    <div class="auction-map-baselayer-toggle">
      <button type="button" :class="{ 'is-active': baseLayer === 'streets' }" @click="baseLayer = 'streets'">
        {{ t('map.baseLayerStreets') }}
      </button>
      <button type="button" :class="{ 'is-active': baseLayer === 'satellite' }" @click="baseLayer = 'satellite'">
        {{ t('map.baseLayerSatellite') }}
      </button>
    </div>
  </div>
</template>

<style>
.auction-map-popup {
  border-radius: 8px;
  padding: 4px;
  min-width: 280px;
  max-width: 320px;
  background: white;
  box-shadow: 0 4px 16px rgb(15 23 42 / 20%);
}

.auction-map-baselayer-toggle {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 10;
  display: flex;
  overflow: hidden;
  border-radius: 6px;
  border: 1px solid rgb(15 23 42 / 15%);
  background: white;
  box-shadow: 0 2px 8px rgb(15 23 42 / 15%);
}

.auction-map-baselayer-toggle button {
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  color: #1f2937;
  background: transparent;
  border: none;
  cursor: pointer;
}

.auction-map-baselayer-toggle button.is-active {
  background: #2563eb;
  color: white;
}
</style>
