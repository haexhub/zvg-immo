<script setup lang="ts">
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import iconUrl from 'leaflet/dist/images/marker-icon.png'
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png'
import shadowUrl from 'leaflet/dist/images/marker-shadow.png'
import { createCountryImageryLayer } from '~/lib/countryImagery'

const props = defineProps<{
  lat: number
  lng: number
  label?: string
  country?: string
}>()

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
  L.control.layers(layers, undefined, { position: 'topright' }).addTo(map)
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
