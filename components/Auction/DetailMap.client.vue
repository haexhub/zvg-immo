<script setup lang="ts">
import OlMap from 'ol/Map'
import OlView from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import XYZ from 'ol/source/XYZ'
import OSM from 'ol/source/OSM'
import { Feature } from 'ol'
import Point from 'ol/geom/Point'
import { circular } from 'ol/geom/Polygon'
import { fromLonLat } from 'ol/proj'
import { createXYZ } from 'ol/tilegrid'
import { Circle as CircleStyle, Fill, Icon, Stroke, Style } from 'ol/style'
import Overlay from 'ol/Overlay'
import { defaults as defaultInteractions } from 'ol/interaction/defaults'
import type BaseLayer from 'ol/layer/Base'
import type { TileCoord } from 'ol/tilecoord'
import { OSM_ATTRIBUTION, mapTilerSatelliteStyleUrl, mapTilerStreetsStyleUrl } from '~/lib/map-tiles'
import { mapPinDataUri, MAP_PIN_ANCHOR } from '~/lib/mapPinIcon'
import { useMapTilerVectorBaseLayer } from '~/composables/useMapTilerVectorBaseLayer'
import type { HazardAssessment, LocationContext, LocationMapFeature } from '~/types/auction'

const props = defineProps<{
  lat: number
  lng: number
  label?: string
  hazards?: HazardAssessment[] | null
  locationContext?: LocationContext | null
}>()

const { t, locale } = useI18n()
const runtimeConfig = useRuntimeConfig()
const mapTilerApiKey = computed(() => String(runtimeConfig.public.maptilerApiKey || '').trim())
const baseLayer = ref<'streets' | 'satellite'>('streets')

// The MapTiler base layer renders as vector tiles (see
// useMapTilerVectorBaseLayer) with labels re-localized to the UI locale — one
// style per mode covers every language. No key configured -> empty URL -> the
// composable stays inert and the raster OSM/Esri fallback below renders
// instead.
const vectorStyleUrl = computed(() => {
  if (!mapTilerApiKey.value) return ''
  return baseLayer.value === 'streets'
    ? mapTilerStreetsStyleUrl(mapTilerApiKey.value, String(runtimeConfig.public.maptilerStreetsMapId || '') || undefined)
    : mapTilerSatelliteStyleUrl(mapTilerApiKey.value, String(runtimeConfig.public.maptilerSatelliteMapId || '') || undefined)
})
const olMapRef = shallowRef<OlMap | null>(null)
useMapTilerVectorBaseLayer({ map: olMapRef, styleUrl: vectorStyleUrl, lang: locale })

function hazardStatusColor(status: HazardAssessment['status']): string {
  if (status === 'inside') return '#dc2626'
  if (status === 'nearby') return '#d97706'
  if (status === 'outside') return '#16a34a'
  return '#64748b'
}

function hazardRadius(hazard: HazardAssessment): number {
  if (hazard.status === 'inside') return 250
  if (hazard.distanceMeters != null && hazard.distanceMeters > 0) {
    return Math.min(Math.max(hazard.distanceMeters, 250), 5_000)
  }
  return 500
}

function hazardOverlayLabel(hazard: HazardAssessment): string {
  return `${t(`objektDetail.hazard.${hazard.hazard}`)}: ${t(`objektDetail.hazardStatus.${hazard.status}`)}`
}

function hazardMapLayerLabel(hazard: HazardAssessment): string {
  return `${t(`objektDetail.mapLayerHazardPrefix`)} ${t(`objektDetail.hazard.${hazard.hazard}`)}`
}

function featureLayerLabel(feature: LocationMapFeature): string {
  if (feature.kind === 'industry' || feature.kind === 'commercial' || feature.kind === 'major_road') return t('objektDetail.mapLayerIndustryRoads')
  if (feature.kind === 'airport' || feature.kind === 'runway' || feature.kind === 'helipad') return t('objektDetail.mapLayerAviation')
  if (feature.kind === 'public_transport' || feature.kind === 'rail' || feature.kind === 'ferry') return t('objektDetail.mapLayerTransport')
  if (feature.kind === 'school' || feature.kind === 'childcare' || feature.kind === 'university') return t('objektDetail.mapLayerEducation')
  if (feature.kind === 'groceries' || feature.kind === 'pharmacy' || feature.kind === 'healthcare' || feature.kind === 'hospital') return t('objektDetail.mapLayerDailyNeeds')
  if (feature.kind === 'restaurant' || feature.kind === 'cafe') return t('objektDetail.mapLayerRestaurantsCafes')
  return t('objektDetail.mapLayerLeisure')
}

function featureColor(feature: LocationMapFeature): string {
  if (feature.kind === 'industry') return '#dc2626'
  if (feature.kind === 'commercial') return '#ea580c'
  if (feature.kind === 'major_road') return '#9333ea'
  if (feature.kind === 'airport' || feature.kind === 'runway') return '#be123c'
  if (feature.kind === 'helipad') return '#e11d48'
  if (feature.kind === 'public_transport' || feature.kind === 'rail') return '#2563eb'
  if (feature.kind === 'ferry') return '#0891b2'
  if (feature.kind === 'school' || feature.kind === 'childcare' || feature.kind === 'university') return '#7c3aed'
  if (feature.kind === 'pharmacy' || feature.kind === 'healthcare' || feature.kind === 'hospital') return '#16a34a'
  if (feature.kind === 'groceries') return '#059669'
  if (feature.kind === 'restaurant') return '#f97316'
  if (feature.kind === 'cafe') return '#a16207'
  if (feature.kind === 'recreation') return '#65a30d'
  return '#64748b'
}

function featureRadius(feature: LocationMapFeature): number {
  if (feature.kind === 'major_road') return 8
  if (feature.kind === 'industry' || feature.kind === 'commercial') return 7
  return 6
}

function featureLabel(feature: LocationMapFeature): string {
  return t(`objektDetail.mapFeatureKind.${feature.kind}`)
}

function featurePopup(feature: LocationMapFeature): string {
  const name = feature.name ? `${escapeHtml(feature.name)}<br>` : ''
  return `${name}${escapeHtml(featureLabel(feature))}<br>${distanceLabel(feature.distanceMeters)}`
}

function distanceLabel(distanceMeters: number): string {
  return distanceMeters < 1000
    ? t('objektDetail.distanceMeters', { meters: distanceMeters.toLocaleString(undefined, { maximumFractionDigits: 0 }) })
    : t('objektDetail.distanceKilometers', { kilometers: (distanceMeters / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

function circularPolygon(lng: number, lat: number, radiusMeters: number) {
  return circular([lng, lat], radiusMeters).transform('EPSG:4326', 'EPSG:3857')
}

interface OverlayEntry {
  key: string
  layer: BaseLayer
  // A ref per entry (rather than a plain boolean) so toggling one checkbox
  // doesn't need the whole entries array/objects to be deeply reactive —
  // that deep-proxying is what makes Vue's template type inference lose the
  // OL layer classes' nominal (private-field-based) typing.
  visible: Ref<boolean>
  // Stable identifier for entries the template needs to find regardless of
  // the current locale — entry.key is a translated label captured once at
  // mount time, so it goes stale on a locale switch.
  id?: string
}

function addOverlayEntry(entries: OverlayEntry[], label: string, layer: BaseLayer, visible: boolean, id?: string): void {
  let key = label
  let index = 2
  while (entries.some((e) => e.key === key)) {
    key = `${label} ${index}`
    index++
  }
  layer.setVisible(visible)
  entries.push({ key, layer, visible: ref(visible), id })
}

// Esri's "export"/"exportImage" REST endpoints render a fresh image per
// request instead of serving a pre-rendered tile pyramid, so the tile's bbox
// has to be computed and passed as a query param on every request.
const arcGisTileGrid = createXYZ()

function arcGisMapLayer(serviceUrl: string, layers: string, opacity: number, attribution: string): TileLayer<XYZ> {
  return arcGisGridLayer(serviceUrl, 'export', { layers }, opacity, attribution)
}

function arcGisGridLayer(
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

function arcGisExportUrl(
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

function addFloodRiskLayer(entries: OverlayEntry[]): void {
  addOverlayEntry(
    entries,
    t('objektDetail.mapLayerFloodRiskAreas'),
    arcGisMapLayer(
      'https://water.discomap.eea.europa.eu/arcgis/rest/services/FloodsDirective/Floods2024_RiskZone_WM/MapServer',
      'show:2',
      0.5,
      'EEA Floods Directive',
    ),
    false,
  )
}

function odorOverlayEntry(entries: OverlayEntry[]): void {
  const environment = props.locationContext?.environment
  if (!environment) return
  const signals = [
    environment.nearestHeavyIndustryDistanceMeters,
    environment.nearestIndustrialDistanceMeters,
  ].filter((distance): distance is number => distance != null)
  const nearest = signals.length ? Math.min(...signals) : null
  if (nearest == null || nearest > 5_000) return
  const radius = Math.min(Math.max(nearest, 300), 5_000)
  const label = t('objektDetail.mapLayerOdorSignals')
  const feature = new Feature({ geometry: circularPolygon(props.lng, props.lat, radius) })
  feature.set('popupHtml', `${label}<br>${distanceLabel(nearest)}`)
  const layer = new VectorLayer({
    source: new VectorSource({ features: [feature] }),
    style: new Style({
      stroke: new Stroke({ color: '#7f1d1d', width: 2, lineDash: [4, 6] }),
      fill: new Fill({ color: rgba('#ef4444', nearest <= 1000 ? 0.12 : 0.06) }),
    }),
  })
  addOverlayEntry(entries, label, layer, false, 'odor')
}

function hazardOverlayEntries(entries: OverlayEntry[]): void {
  for (const hazard of props.hazards ?? []) {
    const color = hazardStatusColor(hazard.status)
    const circleFeature = new Feature({ geometry: circularPolygon(props.lng, props.lat, hazardRadius(hazard)) })
    circleFeature.set('popupHtml', `${hazardOverlayLabel(hazard)}<br>${t('objektDetail.hazardSeverityLabel')} ${t(`objektDetail.hazardSeverity.${hazard.severity}`)}`)
    const dotFeature = new Feature({ geometry: new Point(fromLonLat([props.lng, props.lat])) })
    const layer = new VectorLayer({
      source: new VectorSource({ features: [circleFeature, dotFeature] }),
      style: (feature) => {
        if (feature === dotFeature) {
          return new Style({ image: new CircleStyle({ radius: 7, fill: new Fill({ color }), stroke: new Stroke({ color, width: 2 }) }) })
        }
        return new Style({
          stroke: new Stroke({ color, width: 2, lineDash: hazard.status === 'inside' ? undefined : [6, 6] }),
          fill: new Fill({ color: rgba(color, hazard.status === 'inside' ? 0.18 : 0.08) }),
        })
      },
    })
    addOverlayEntry(entries, hazardMapLayerLabel(hazard), layer, false)
  }
}

function featureOverlayEntries(entries: OverlayEntry[]): void {
  const layersByLabel = new Map<string, VectorSource>()
  for (const feature of props.locationContext?.mapFeatures ?? []) {
    const label = featureLayerLabel(feature)
    let source = layersByLabel.get(label)
    if (!source) {
      source = new VectorSource()
      layersByLabel.set(label, source)
    }
    const olFeature = new Feature({ geometry: new Point(fromLonLat([feature.lng, feature.lat])) })
    olFeature.set('data', feature)
    olFeature.set('popupHtml', featurePopup(feature))
    source.addFeature(olFeature)
  }
  for (const [label, source] of layersByLabel) {
    const layer = new VectorLayer({
      source,
      style: (olFeature) => {
        const data = olFeature.get('data') as LocationMapFeature
        const color = featureColor(data)
        return new Style({
          image: new CircleStyle({
            radius: featureRadius(data),
            fill: new Fill({ color: rgba(color, data.kind === 'major_road' ? 0.45 : 0.75) }),
            stroke: new Stroke({ color, width: 2 }),
          }),
        })
      },
    })
    // Visible by default, unlike the noise/flood/hazard/odor overlays above —
    // matches the Leaflet version, which added these straight to the map
    // instead of only registering them with the layer-switcher control.
    addOverlayEntry(entries, label, layer, true)
  }
}

const mapEl = ref<HTMLDivElement | null>(null)
const popupEl = ref<HTMLDivElement | null>(null)
let map: OlMap | null = null

const panelOpen = ref(false)
const overlayEntries = shallowRef<OverlayEntry[]>([])

function toggleOverlay(entry: OverlayEntry): void {
  entry.visible.value = !entry.visible.value
  entry.layer.setVisible(entry.visible.value)
}

interface LegendEntry {
  key: string
  color: string
  label: string
}

const legendOpen = ref(true)

const featureLegendEntries = computed<LegendEntry[]>(() => {
  const byKind = new Map<string, LegendEntry>()
  for (const feature of props.locationContext?.mapFeatures ?? []) {
    if (!byKind.has(feature.kind)) {
      byKind.set(feature.kind, { key: feature.kind, color: featureColor(feature), label: featureLabel(feature) })
    }
  }
  return [...byKind.values()]
})

const hazardStatusLegendEntries = computed<LegendEntry[]>(() => {
  if (!props.hazards?.length) return []
  return (['inside', 'nearby', 'outside', 'unknown'] as const).map((status) => ({
    key: status,
    color: hazardStatusColor(status),
    label: t(`objektDetail.hazardStatus.${status}`),
  }))
})

const showOdorLegend = computed(() => overlayEntries.value.some((entry) => entry.id === 'odor'))

onMounted(async () => {
  // The parent gates this component behind v-if="a.lat != null && a.lng != null".
  // The ref binding races with the v-if flip when the data arrives, so wait a
  // tick before reading mapEl — otherwise OpenLayers silently no-ops on a null el.
  await nextTick()
  if (!mapEl.value || !popupEl.value) return

  // The MapTiler vector base layer (useMapTilerVectorBaseLayer, wired up
  // above) is inserted imperatively at the bottom of the layer stack once a
  // key is configured; this raster fallback only renders without one.
  const rasterFallbackLayers: BaseLayer[] = []
  if (!mapTilerApiKey.value) {
    const streets = new TileLayer({ source: new OSM({ attributions: OSM_ATTRIBUTION }) })
    const esriImagery = new TileLayer({
      source: new XYZ({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attributions: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
      }),
    })
    // A dedicated labels/boundaries overlay with a transparent background,
    // paired with satellite imagery (a full opaque basemap blended at low
    // opacity over it would just look washed out).
    const placeLabels = new TileLayer({
      source: new XYZ({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        attributions: 'Tiles &copy; Esri',
      }),
    })
    streets.setVisible(baseLayer.value === 'streets')
    esriImagery.setVisible(baseLayer.value !== 'streets')
    placeLabels.setVisible(baseLayer.value !== 'streets')
    watch(baseLayer, (value) => {
      streets.setVisible(value === 'streets')
      esriImagery.setVisible(value !== 'streets')
      placeLabels.setVisible(value !== 'streets')
    })
    rasterFallbackLayers.push(streets, esriImagery, placeLabels)
  }

  const entries: OverlayEntry[] = []
  addFloodRiskLayer(entries)
  featureOverlayEntries(entries)
  odorOverlayEntry(entries)
  hazardOverlayEntries(entries)
  overlayEntries.value = entries

  const markerFeature = new Feature({ geometry: new Point(fromLonLat([props.lng, props.lat])) })
  const markerLayer = new VectorLayer({
    source: new VectorSource({ features: [markerFeature] }),
    style: new Style({ image: new Icon({ src: mapPinDataUri('#2563eb'), anchor: MAP_PIN_ANCHOR }) }),
  })

  const popupOverlay = new Overlay({
    element: popupEl.value,
    offset: [0, -12],
    positioning: 'bottom-center',
  })

  map = new OlMap({
    target: mapEl.value,
    interactions: defaultInteractions({ mouseWheelZoom: false }),
    layers: [...rasterFallbackLayers, ...entries.map((e) => e.layer), markerLayer],
    overlays: [popupOverlay],
    view: new OlView({ center: fromLonLat([props.lng, props.lat]), zoom: 14 }),
  })
  olMapRef.value = map

  map.on('click', (evt) => {
    const feature = map!.forEachFeatureAtPixel(evt.pixel, (f) => f)
    const html = feature?.get('popupHtml') as string | undefined
    if (!html) {
      popupOverlay.setPosition(undefined)
      return
    }
    popupEl.value!.innerHTML = html
    popupOverlay.setPosition(evt.coordinate)
  })
})

onBeforeUnmount(() => {
  if (map) {
    map.setTarget(undefined)
    map = null
  }
  olMapRef.value = null
})
</script>

<template>
  <div class="relative h-[24rem] w-full overflow-hidden rounded-xl border shadow-sm md:h-[32rem]">
    <div ref="mapEl" class="h-full w-full" />
    <div ref="popupEl" class="auction-detail-map-popup" />
    <div class="auction-detail-map-layers">
      <button
        type="button"
        class="auction-detail-map-layers__toggle"
        :aria-expanded="panelOpen"
        aria-controls="auction-detail-map-layers-panel"
        @click="panelOpen = !panelOpen"
      >
        {{ t('map.layers') }}
      </button>
      <div v-if="panelOpen" id="auction-detail-map-layers-panel" class="auction-detail-map-layers__panel">
        <div class="auction-detail-map-layers__group">
          <label><input v-model="baseLayer" type="radio" value="streets"> {{ t('map.baseLayerStreets') }}</label>
          <label><input v-model="baseLayer" type="radio" value="satellite"> {{ t('map.baseLayerSatellite') }}</label>
        </div>
        <div v-if="overlayEntries.length" class="auction-detail-map-layers__overlays">
          <label v-for="entry in overlayEntries" :key="entry.key">
            <input type="checkbox" :checked="entry.visible.value" @change="toggleOverlay(entry)"> {{ entry.key }}
          </label>
        </div>
      </div>
    </div>
    <div class="auction-detail-map-legend">
      <button
        type="button"
        class="auction-detail-map-legend__toggle"
        :aria-expanded="legendOpen"
        aria-controls="auction-detail-map-legend-panel"
        @click="legendOpen = !legendOpen"
      >
        {{ t('map.legend') }}
      </button>
      <div v-if="legendOpen" id="auction-detail-map-legend-panel" class="auction-detail-map-legend__panel">
        <div class="auction-detail-map-legend__item">
          <span class="auction-detail-map-legend__pin" />
          {{ t('map.legendSubject') }}
        </div>
        <div v-for="entry in featureLegendEntries" :key="entry.key" class="auction-detail-map-legend__item">
          <span class="auction-detail-map-legend__swatch" :style="{ backgroundColor: entry.color }" />
          {{ entry.label }}
        </div>
        <template v-if="hazardStatusLegendEntries.length">
          <div class="auction-detail-map-legend__group-title">{{ t('objektDetail.hazardsTitle') }}</div>
          <div v-for="entry in hazardStatusLegendEntries" :key="entry.key" class="auction-detail-map-legend__item">
            <span class="auction-detail-map-legend__swatch" :style="{ backgroundColor: entry.color }" />
            {{ entry.label }}
          </div>
        </template>
        <div v-if="showOdorLegend" class="auction-detail-map-legend__item">
          <span class="auction-detail-map-legend__swatch auction-detail-map-legend__swatch--dashed" />
          {{ t('objektDetail.mapLayerOdorSignals') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auction-detail-map-popup:empty {
  display: none;
}

.auction-detail-map-popup {
  border-radius: 8px;
  padding: 4px 8px;
  min-width: 140px;
  max-width: 260px;
  background: white;
  font-size: 12px;
  line-height: 1.35;
  box-shadow: 0 4px 16px rgb(15 23 42 / 20%);
}

.auction-detail-map-layers,
.auction-detail-map-legend {
  position: absolute;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.auction-detail-map-layers {
  top: 8px;
  right: 8px;
  align-items: flex-end;
}

.auction-detail-map-legend {
  bottom: 8px;
  left: 8px;
  align-items: flex-start;
}

.auction-detail-map-layers__toggle,
.auction-detail-map-legend__toggle {
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  color: #111827;
  background: rgb(255 255 255 / 98%);
  border: 1px solid rgb(15 23 42 / 15%);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgb(15 23 42 / 15%);
  cursor: pointer;
}

.auction-detail-map-layers__panel,
.auction-detail-map-legend__panel {
  width: 15rem;
  max-height: 15rem;
  overflow-y: auto;
  padding: 6px 8px;
  color: #111827;
  background: rgb(255 255 255 / 96%);
  border: 1px solid rgb(15 23 42 / 15%);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgb(15 23 42 / 15%);
  font-size: 12px;
  line-height: 1.25;
  backdrop-filter: blur(4px);
}

.auction-detail-map-layers__group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 6px;
  margin-bottom: 6px;
  border-bottom: 1px solid rgb(15 23 42 / 10%);
}

.auction-detail-map-layers__overlays {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.auction-detail-map-layers label {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 20px;
  cursor: pointer;
}

.auction-detail-map-layers input {
  flex: 0 0 auto;
  accent-color: #2563eb;
}

.auction-detail-map-legend__group-title {
  padding-top: 4px;
  margin-top: 4px;
  font-weight: 600;
  border-top: 1px solid rgb(15 23 42 / 10%);
}

.auction-detail-map-legend__item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 18px;
}

.auction-detail-map-legend__swatch {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.auction-detail-map-legend__swatch--dashed {
  background: rgb(239 68 68 / 15%);
  border: 1.5px dashed #7f1d1d;
}

.auction-detail-map-legend__pin {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  background: #2563eb;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
}
</style>
