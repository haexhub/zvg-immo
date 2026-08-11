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
import { Fill, Icon, Stroke, Style } from 'ol/style'
import Overlay from 'ol/Overlay'
import { defaults as defaultInteractions } from 'ol/interaction/defaults'
import type BaseLayer from 'ol/layer/Base'
import type { TileCoord } from 'ol/tilecoord'
import { OSM_ATTRIBUTION, mapTilerSatelliteStyleUrl, mapTilerStreetsStyleUrl } from '~/lib/map-tiles'
import { mapPinDataUri, MAP_PIN_ANCHOR } from '~/lib/mapPinIcon'
import { featureIconDataUri, hazardIconDataUri, odorLegendIconDataUri } from '~/lib/mapFeatureIcon'
import { minOf } from '~/lib/array-math'
import { featureColor, hazardRadius, hazardStatusColor, rgba } from '~/lib/auction-map-overlays'
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
const { hazardDetailLine, hazardOverlayLabel } = useHazardDisplay()
const { formatDistance } = useAuctionDetailFormatters()
const runtimeConfig = useRuntimeConfig()
const mapTilerApiKey = computed(() => String(runtimeConfig.public.maptilerApiKey || '').trim())
const baseLayer = ref<'streets' | 'satellite'>('streets')
// Same blue as Auction/Map.client.vue's PIN_COLOR (Tailwind's blue-600,
// matching accent-blue-600 further down) — named once here since it's baked
// into an SVG data URI for both the map marker and the legend swatch below,
// not a DOM class Tailwind could reach.
const SUBJECT_PIN_COLOR = '#2563eb'
const controlToggleClass = 'cursor-pointer rounded-md border border-slate-900/15 bg-white/95 px-2.5 py-1 text-xs font-semibold text-gray-900 shadow-sm'
const controlPanelClass = 'max-h-60 w-60 overflow-y-auto rounded-md border border-slate-900/15 bg-white/95 px-2 py-1.5 text-xs leading-tight text-gray-900 shadow-sm backdrop-blur-sm'
const layerLabelClass = 'flex min-h-5 cursor-pointer items-center gap-1'
const layerInputClass = 'shrink-0 accent-blue-600'

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

function featureLabel(feature: LocationMapFeature): string {
  return t(`objektDetail.mapFeatureKind.${feature.kind}`)
}

function featurePopup(feature: LocationMapFeature): string {
  const name = feature.name ? `${escapeHtml(feature.name)}<br>` : ''
  return `${name}${escapeHtml(featureLabel(feature))}<br>${formatDistance(feature.distanceMeters)}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
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
  const nearest = signals.length ? minOf(signals) : null
  if (nearest == null || nearest > 5_000) return
  const radius = Math.min(Math.max(nearest, 300), 5_000)
  const label = t('objektDetail.mapLayerOdorSignals')
  const feature = new Feature({ geometry: circularPolygon(props.lng, props.lat, radius) })
  feature.set('popupHtml', () => `${t('objektDetail.mapLayerOdorSignals')}<br>${formatDistance(nearest)}`)
  const layer = new VectorLayer({
    source: new VectorSource({ features: [feature] }),
    style: new Style({
      stroke: new Stroke({ color: '#7f1d1d', width: 2, lineDash: [4, 6] }),
      fill: new Fill({ color: rgba('#ef4444', nearest <= 1000 ? 0.12 : 0.06) }),
    }),
  })
  addOverlayEntry(entries, label, layer, false, 'odor')
}

// Set by hovering a legend row (see hoveredFeatureKind/hoveredHazardKind
// below) so the matching markers can be scaled up and drawn on top — the
// vector layers' style functions read these on every render.
const hoveredFeatureKind = ref<string | null>(null)
const hoveredHazardKind = ref<string | null>(null)
const HOVER_SCALE = 1.5
const HOVER_LAYER_Z_INDEX = 10

// Style.zIndex (used above) only reorders features *within* one layer — each
// hazard/feature-label group is its own separate VectorLayer, so lifting a
// hovered marker above one from a *different* layer needs that layer raised
// too. Layers register their kind(s) here; the watch below sets each one's
// zIndex based on whether the hovered kind is among them.
const hoverableLayers: { layer: VectorLayer<VectorSource>, group: 'feature' | 'hazard', kinds: Set<string> }[] = []

function hazardOverlayEntries(entries: OverlayEntry[]): void {
  for (const hazard of props.hazards ?? []) {
    const color = hazardStatusColor(hazard.status)
    const circleFeature = new Feature({ geometry: circularPolygon(props.lng, props.lat, hazardRadius(hazard)) })
    circleFeature.set('popupHtml', () => [hazardOverlayLabel(hazard), hazardDetailLine(hazard)].filter(Boolean).join('<br>'))
    const dotFeature = new Feature({ geometry: new Point(fromLonLat([props.lng, props.lat])) })
    const layer = new VectorLayer({
      source: new VectorSource({ features: [circleFeature, dotFeature] }),
      style: (feature) => {
        const hovered = hoveredHazardKind.value === hazard.hazard
        if (feature === dotFeature) {
          return new Style({
            image: new Icon({ src: hazardIconDataUri(hazard.hazard, color), scale: hovered ? HOVER_SCALE : 1 }),
            zIndex: hovered ? 10 : 0,
          })
        }
        return new Style({
          stroke: new Stroke({ color, width: hovered ? 3.5 : 2, lineDash: hazard.status === 'inside' ? undefined : [6, 6] }),
          fill: new Fill({ color: rgba(color, (hazard.status === 'inside' ? 0.18 : 0.08) * (hovered ? 2 : 1)) }),
        })
      },
    })
    hoverableLayers.push({ layer, group: 'hazard', kinds: new Set([hazard.hazard]) })
    addOverlayEntry(entries, hazardMapLayerLabel(hazard), layer, false)
  }
}

function featureOverlayEntries(entries: OverlayEntry[]): void {
  const layersByLabel = new Map<string, VectorSource>()
  const kindsByLabel = new Map<string, Set<string>>()
  for (const feature of props.locationContext?.mapFeatures ?? []) {
    const label = featureLayerLabel(feature)
    let source = layersByLabel.get(label)
    if (!source) {
      source = new VectorSource()
      layersByLabel.set(label, source)
      kindsByLabel.set(label, new Set())
    }
    kindsByLabel.get(label)!.add(feature.kind)
    const olFeature = new Feature({ geometry: new Point(fromLonLat([feature.lng, feature.lat])) })
    olFeature.set('data', feature)
    olFeature.set('popupHtml', () => featurePopup(feature))
    source.addFeature(olFeature)
  }
  for (const [label, source] of layersByLabel) {
    const layer = new VectorLayer({
      source,
      style: (olFeature) => {
        const data = olFeature.get('data') as LocationMapFeature
        const hovered = hoveredFeatureKind.value === data.kind
        return new Style({
          image: new Icon({ src: featureIconDataUri(data.kind, featureColor(data)), scale: hovered ? HOVER_SCALE : 1 }),
          zIndex: hovered ? 10 : 0,
        })
      },
    })
    hoverableLayers.push({ layer, group: 'feature', kinds: kindsByLabel.get(label)! })
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

// Style functions above read the hovered-kind refs directly, but OL only
// re-invokes them on a render pass — nudge every overlay layer to redraw
// when the hover target changes so the highlight actually appears. Layers
// default to zIndex 0 when unset, so resetting a non-matching layer to 0
// here is enough to drop it back below the (still-10) hovered one.
watch([hoveredFeatureKind, hoveredHazardKind], () => {
  for (const entry of overlayEntries.value) entry.layer.changed()
  for (const { layer, group, kinds } of hoverableLayers) {
    const hovered = group === 'feature' ? hoveredFeatureKind.value : hoveredHazardKind.value
    layer.setZIndex(hovered != null && kinds.has(hovered) ? HOVER_LAYER_Z_INDEX : 0)
  }
})

function toggleOverlay(entry: OverlayEntry): void {
  entry.visible.value = !entry.visible.value
  entry.layer.setVisible(entry.visible.value)
}

interface LegendEntry {
  key: string
  color: string
  label: string
  icon: string
}

const legendOpen = ref(true)

const featureLegendEntries = computed<LegendEntry[]>(() => {
  const byKind = new Map<string, LegendEntry>()
  for (const feature of props.locationContext?.mapFeatures ?? []) {
    if (!byKind.has(feature.kind)) {
      const color = featureColor(feature)
      byKind.set(feature.kind, { key: feature.kind, color, label: featureLabel(feature), icon: featureIconDataUri(feature.kind, color) })
    }
  }
  return [...byKind.values()]
})

const hazardLegendEntries = computed<LegendEntry[]>(() => {
  return (props.hazards ?? []).map((hazard) => {
    const color = hazardStatusColor(hazard.status)
    return { key: hazard.hazard, color, label: hazardOverlayLabel(hazard), icon: hazardIconDataUri(hazard.hazard, color) }
  })
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
    // Scaled up and always above every hazard/feature layer (including a
    // hovered one, see HOVER_LAYER_Z_INDEX above) so the subject property
    // always reads as the one marker that matters. Set on the layer itself,
    // not just the Style, since Style.zIndex alone can't lift a feature
    // above features that live in a different layer.
    zIndex: 20,
    style: new Style({ image: new Icon({ src: mapPinDataUri(SUBJECT_PIN_COLOR), anchor: MAP_PIN_ANCHOR, scale: 1.6 }) }),
  })

  const popupOverlay = new Overlay({
    element: popupEl.value,
    offset: [0, -12],
    positioning: 'bottom-center',
    autoPan: { margin: 20 },
  })

  map = new OlMap({
    target: mapEl.value,
    // OL's own click/drag threshold defaults to 1px, so a mouse/trackpad
    // click that drifts by 2px+ between press and release gets reclassified
    // as a pan and never fires 'click' at all — the popup click handler
    // below then never runs and an open popup can't be dismissed.
    moveTolerance: 8,
    interactions: defaultInteractions({ mouseWheelZoom: false }),
    layers: [...rasterFallbackLayers, ...entries.map((e) => e.layer), markerLayer],
    overlays: [popupOverlay],
    view: new OlView({ center: fromLonLat([props.lng, props.lat]), zoom: 14 }),
  })
  olMapRef.value = map

  map.on('click', (evt) => {
    const feature = map!.forEachFeatureAtPixel(evt.pixel, (f) => f)
    // Stored as a thunk (not a plain string) so the popup re-renders with the
    // active locale/formatters on every click instead of the one baked in
    // when the layers were built in onMounted.
    const popupHtml = feature?.get('popupHtml') as (() => string) | undefined
    const html = popupHtml?.()
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
    <div ref="popupEl" class="empty:hidden min-w-[140px] max-w-[260px] rounded-lg bg-white px-2 py-1 text-xs leading-[1.35] text-gray-900 shadow-lg" />
    <div class="absolute top-2 right-2 z-10 flex flex-col items-end gap-1">
      <button
        type="button"
        :class="controlToggleClass"
        :aria-expanded="panelOpen"
        aria-controls="auction-detail-map-layers-panel"
        @click="panelOpen = !panelOpen"
      >
        {{ t('map.layers') }}
      </button>
      <div v-if="panelOpen" id="auction-detail-map-layers-panel" :class="controlPanelClass">
        <div class="mb-1.5 flex flex-col gap-0.5 border-b border-slate-900/10 pb-1.5">
          <label :class="layerLabelClass">
            <input v-model="baseLayer" type="radio" value="streets" :class="layerInputClass"> {{ t('map.baseLayerStreets') }}
          </label>
          <label :class="layerLabelClass">
            <input v-model="baseLayer" type="radio" value="satellite" :class="layerInputClass"> {{ t('map.baseLayerSatellite') }}
          </label>
        </div>
        <div v-if="overlayEntries.length" class="flex flex-col gap-0.5">
          <label v-for="entry in overlayEntries" :key="entry.key" :class="layerLabelClass">
            <input type="checkbox" :checked="entry.visible.value" :class="layerInputClass" @change="toggleOverlay(entry)"> {{ entry.key }}
          </label>
        </div>
      </div>
    </div>
    <AuctionDetailMapLegend
      v-model:open="legendOpen"
      :feature-entries="featureLegendEntries"
      :hazard-entries="hazardLegendEntries"
      :show-odor="showOdorLegend"
      :subject-icon="mapPinDataUri(SUBJECT_PIN_COLOR)"
      :subject-label="t('map.legendSubject')"
      :hazards-title="t('objektDetail.hazardsTitle')"
      :odor-icon="odorLegendIconDataUri()"
      :odor-label="t('objektDetail.mapLayerOdorSignals')"
      :toggle-class="controlToggleClass"
      :panel-class="controlPanelClass"
      :toggle-label="t('map.legend')"
      @hover-feature="hoveredFeatureKind = $event"
      @hover-hazard="hoveredHazardKind = $event"
    />
  </div>
</template>
