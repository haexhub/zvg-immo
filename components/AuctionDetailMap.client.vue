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

function featureLayerLabel(feature: LocationMapFeature): string {
  if (feature.kind === 'industry' || feature.kind === 'commercial' || feature.kind === 'major_road') return t('objektDetail.mapLayerIndustryRoads')
  if (feature.kind === 'public_transport' || feature.kind === 'rail' || feature.kind === 'ferry') return t('objektDetail.mapLayerTransport')
  if (feature.kind === 'school' || feature.kind === 'childcare' || feature.kind === 'university') return t('objektDetail.mapLayerEducation')
  if (feature.kind === 'groceries' || feature.kind === 'pharmacy' || feature.kind === 'healthcare') return t('objektDetail.mapLayerDailyNeeds')
  return t('objektDetail.mapLayerLeisure')
}

function featureColor(feature: LocationMapFeature): string {
  if (feature.kind === 'industry') return '#dc2626'
  if (feature.kind === 'commercial') return '#ea580c'
  if (feature.kind === 'major_road') return '#9333ea'
  if (feature.kind === 'public_transport' || feature.kind === 'rail') return '#2563eb'
  if (feature.kind === 'ferry') return '#0891b2'
  if (feature.kind === 'school' || feature.kind === 'childcare' || feature.kind === 'university') return '#7c3aed'
  if (feature.kind === 'pharmacy' || feature.kind === 'healthcare') return '#16a34a'
  if (feature.kind === 'groceries') return '#059669'
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
  const distance = feature.distanceMeters < 1000
    ? t('objektDetail.distanceMeters', { meters: feature.distanceMeters.toLocaleString(undefined, { maximumFractionDigits: 0 }) })
    : t('objektDetail.distanceKilometers', { kilometers: (feature.distanceMeters / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) })
  return `${name}${escapeHtml(featureLabel(feature))}<br>${distance}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
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
    overlays[label] = group
    group.addTo(map)
  }
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
    overlays[hazardOverlayLabel(hazard)] = group
  }
  L.control.layers(layers, overlays, { position: 'topright' }).addTo(map)
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
