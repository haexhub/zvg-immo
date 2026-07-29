<script setup lang="ts">
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import iconUrl from 'leaflet/dist/images/marker-icon.png'
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png'
import shadowUrl from 'leaflet/dist/images/marker-shadow.png'
import { createCountryImageryLayer } from '~/lib/countryImagery'
import type { HazardAssessment, LocationContext, LocationMapFeature } from '~/types/auction'

const props = defineProps<{
  lat: number
  lng: number
  label?: string
  country?: string
  hazards?: HazardAssessment[] | null
  locationContext?: LocationContext | null
}>()

const { t } = useI18n()
const markerIcon = L.icon({
  iconUrl,
  iconRetinaUrl,
  shadowUrl,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  tooltipAnchor: [16, -28],
  shadowSize: [41, 41],
})

const mapEl = ref<HTMLDivElement | null>(null)
let map: L.Map | null = null

const runtimeConfig = useRuntimeConfig()
const countryImageryKeys = {
  fi: runtimeConfig.public.mmlApiKey as string,
  dk: runtimeConfig.public.datafordelerApiKey as string,
}

function hazardColor(hazard: HazardAssessment): string {
  if (hazard.status === 'inside') return '#dc2626'
  if (hazard.status === 'nearby') return '#d97706'
  if (hazard.status === 'outside') return '#16a34a'
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

function addOverlay(overlays: Record<string, L.Layer>, label: string, layer: L.Layer): void {
  let key = label
  let index = 2
  while (overlays[key]) {
    key = `${label} ${index}`
    index++
  }
  overlays[key] = layer
}

function arcGisImageLayer(serviceUrl: string, opacity: number, attribution: string): L.GridLayer {
  return arcGisGridLayer(serviceUrl, 'exportImage', {}, opacity, attribution)
}

function arcGisMapLayer(serviceUrl: string, layers: string, opacity: number, attribution: string): L.GridLayer {
  return arcGisGridLayer(serviceUrl, 'export', { layers }, opacity, attribution)
}

function arcGisGridLayer(
  serviceUrl: string,
  operation: 'export' | 'exportImage',
  params: Record<string, string>,
  opacity: number,
  attribution: string,
): L.GridLayer {
  const Layer = L.GridLayer.extend({
    createTile(this: L.GridLayer, coords: L.Coords, done: (error?: Error, tile?: HTMLElement) => void): HTMLElement {
      const tile = document.createElement('img')
      tile.alt = ''
      tile.decoding = 'async'
      tile.loading = 'lazy'
      tile.referrerPolicy = 'no-referrer'
      tile.onload = () => done(undefined, tile)
      tile.onerror = () => done(new Error(`Failed to load ${serviceUrl}`), tile)
      tile.src = arcGisExportUrl(serviceUrl, coords, this.getTileSize(), operation, params)
      return tile
    },
  })
  const ArcGisLayer = Layer as unknown as { new(options: L.GridLayerOptions): L.GridLayer }
  return new ArcGisLayer({
    opacity,
    attribution,
    minZoom: 6,
    maxZoom: 18,
  }) as L.GridLayer
}

function arcGisExportUrl(
  serviceUrl: string,
  coords: L.Coords,
  tileSize: L.Point,
  operation: 'export' | 'exportImage',
  extraParams: Record<string, string> = {},
): string {
  const nwPoint = coords.scaleBy(tileSize)
  const sePoint = nwPoint.add(tileSize)
  const nw = L.CRS.EPSG3857.project(L.CRS.EPSG3857.pointToLatLng(nwPoint, coords.z))
  const se = L.CRS.EPSG3857.project(L.CRS.EPSG3857.pointToLatLng(sePoint, coords.z))
  const url = new URL(`${serviceUrl.replace(/\/+$/, '')}/${operation}`)
  url.searchParams.set('bbox', `${nw.x},${se.y},${se.x},${nw.y}`)
  url.searchParams.set('bboxSR', '3857')
  url.searchParams.set('imageSR', '3857')
  url.searchParams.set('size', `${tileSize.x},${tileSize.y}`)
  url.searchParams.set('format', 'png32')
  url.searchParams.set('transparent', 'true')
  url.searchParams.set('f', 'image')
  for (const [key, value] of Object.entries(extraParams)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

function addEnvironmentalMapLayers(overlays: Record<string, L.Layer>): void {
  const noiseBase = 'https://noise.discomap.eea.europa.eu/arcgis/rest/services/noiseStoryMap'
  const noiseAttribution = 'EEA Environmental Noise Directive'
  addOverlay(overlays, t('objektDetail.mapLayerNoiseRoadDay'), arcGisImageLayer(`${noiseBase}/NoiseContours_road_lden/ImageServer`, 0.55, noiseAttribution))
  addOverlay(overlays, t('objektDetail.mapLayerNoiseRoadNight'), arcGisImageLayer(`${noiseBase}/NoiseContours_road_lnight/ImageServer`, 0.55, noiseAttribution))
  addOverlay(overlays, t('objektDetail.mapLayerNoiseRailDay'), arcGisImageLayer(`${noiseBase}/NoiseContours_rail_lden/ImageServer`, 0.55, noiseAttribution))
  addOverlay(overlays, t('objektDetail.mapLayerNoiseRailNight'), arcGisImageLayer(`${noiseBase}/NoiseContours_rail_lnight/ImageServer`, 0.55, noiseAttribution))
  addOverlay(overlays, t('objektDetail.mapLayerNoiseAviationDay'), arcGisImageLayer(`${noiseBase}/NoiseContours_air_lden/ImageServer`, 0.55, noiseAttribution))
  addOverlay(overlays, t('objektDetail.mapLayerNoiseAviationNight'), arcGisImageLayer(`${noiseBase}/NoiseContours_air_lnight/ImageServer`, 0.55, noiseAttribution))
  addOverlay(
    overlays,
    t('objektDetail.mapLayerFloodRiskAreas'),
    arcGisMapLayer(
      'https://water.discomap.eea.europa.eu/arcgis/rest/services/FloodsDirective/FloodsRiskZone_WM/MapServer',
      'show:2',
      0.5,
      'EEA Floods Directive',
    ),
  )
}

function odorSignalLayer(): L.Layer | null {
  const environment = props.locationContext?.environment
  if (!environment) return null
  const signals = [
    environment.nearestHeavyIndustryDistanceMeters,
    environment.nearestIndustrialDistanceMeters,
  ].filter((distance): distance is number => distance != null)
  const nearest = signals.length ? Math.min(...signals) : null
  if (nearest == null || nearest > 5_000) return null
  const radius = Math.min(Math.max(nearest, 300), 5_000)
  const label = t('objektDetail.mapLayerOdorSignals')
  return L.layerGroup([
    L.circle([props.lat, props.lng], {
      radius,
      color: '#7f1d1d',
      weight: 2,
      opacity: 0.85,
      fillColor: '#ef4444',
      fillOpacity: nearest <= 1000 ? 0.12 : 0.06,
      dashArray: '4 6',
    }).bindPopup(`${label}<br>${distanceLabel(nearest)}`),
  ])
}

onMounted(async () => {
  // The parent gates this component behind v-if="a.lat != null && a.lng != null".
  // The ref binding races with the v-if flip when the data arrives, so wait a
  // tick before reading mapEl — otherwise Leaflet silently no-ops on a null el.
  await nextTick()
  if (!mapEl.value) return
  map = L.map(mapEl.value, { scrollWheelZoom: false }).setView([props.lat, props.lng], 14)
  const streets = L.tileLayer('https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> Deutschland',
    maxZoom: 18,
  }).addTo(map)
  const esriImagery = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
      maxZoom: 19,
    },
  )
  // A handful of countries publish free, keyless orthophotos sharper than
  // Esri World Imagery for their own territory — layer that over Esri when
  // available (not instead of it: the national layer stops at its country's
  // bounds/minZoom, so Esri has to stay underneath for panning and zooming
  // beyond them). Some of these sources have tile-alignment bugs (opaque
  // no-data spillover into neighbouring countries) that Esri alone doesn't
  // have, so offer a plain Esri-only view as an escape hatch.
  const countryImagery = createCountryImageryLayer(props.country, countryImageryKeys)
  // A full opaque basemap (like the streets layer) blended at low opacity
  // over satellite tiles just looks washed out — this is a dedicated
  // labels/boundaries overlay with a transparent background instead.
  const placeLabels = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: 'Tiles &copy; Esri',
      maxZoom: 19,
    },
  )
  const satelliteEsriOnly = L.layerGroup([esriImagery, placeLabels])
  const layers: Record<string, L.Layer> = { Straße: streets, 'Satellit (nur Esri)': satelliteEsriOnly }
  if (countryImagery) {
    layers['Satellit (Länder-Tiles)'] = L.layerGroup([esriImagery, countryImagery, placeLabels])
  }
  const overlays: Record<string, L.Layer> = {}
  addEnvironmentalMapLayers(overlays)
  const featureGroups: Record<string, L.LayerGroup> = {}
  for (const feature of props.locationContext?.mapFeatures ?? []) {
    const label = featureLayerLabel(feature)
    const group = featureGroups[label] ?? L.layerGroup()
    featureGroups[label] = group
    const color = featureColor(feature)
    L.circleMarker([feature.lat, feature.lng], {
      radius: featureRadius(feature),
      color,
      weight: 2,
      opacity: 0.9,
      fillColor: color,
      fillOpacity: feature.kind === 'major_road' ? 0.45 : 0.75,
    })
      .bindPopup(featurePopup(feature))
      .addTo(group)
  }
  for (const [label, group] of Object.entries(featureGroups)) {
    addOverlay(overlays, label, group)
    group.addTo(map)
  }
  const odorLayer = odorSignalLayer()
  if (odorLayer) addOverlay(overlays, t('objektDetail.mapLayerOdorSignals'), odorLayer)
  for (const hazard of props.hazards ?? []) {
    const color = hazardColor(hazard)
    const group = L.layerGroup([
      L.circle([props.lat, props.lng], {
        radius: hazardRadius(hazard),
        color,
        weight: 2,
        opacity: 0.85,
        fillColor: color,
        fillOpacity: hazard.status === 'inside' ? 0.18 : 0.08,
        dashArray: hazard.status === 'inside' ? undefined : '6 6',
      }).bindPopup(
        `${hazardOverlayLabel(hazard)}<br>${t(`objektDetail.hazardSeverityLabel`)} ${t(`objektDetail.hazardSeverity.${hazard.severity}`)}`,
      ),
      L.circleMarker([props.lat, props.lng], {
        radius: 7,
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.9,
      }),
    ])
    addOverlay(overlays, hazardMapLayerLabel(hazard), group)
  }
  L.control.layers(layers, overlays, { position: 'topright', collapsed: true }).addTo(map)
  const marker = L.marker([props.lat, props.lng], { icon: markerIcon })
  if (props.label) marker.bindTooltip(props.label)
  marker.addTo(map)
})

onBeforeUnmount(() => {
  if (map) {
    map.remove()
    map = null
  }
})
</script>

<template>
  <div ref="mapEl" class="h-72 w-full rounded-xl border shadow-sm overflow-hidden" />
</template>

<style scoped>
:deep(.leaflet-control-layers-expanded) {
  max-height: 15rem;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.25;
}
</style>
