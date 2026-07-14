<script setup lang="ts">
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import L from 'leaflet'
import 'leaflet.markercluster'
import { createApp, type App as VueApp } from 'vue'
import iconUrl from 'leaflet/dist/images/marker-icon.png'
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png'
import shadowUrl from 'leaflet/dist/images/marker-shadow.png'
import type { GeoAuction } from '~/server/api/auctions-geo.get'
import LotPopover from '~/components/LotPopover.vue'
import { createAllCountryImageryLayers } from '~/lib/countryImagery'

// Pass an explicit Icon to every marker. Mutating L.Icon.Default at module
// top level was tree-shaken by the production build, so the markers fell
// back to relative filenames that 404 from the site root.
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

const props = defineProps<{
  auctions: GeoAuction[]
  /** Bumping this string requests a re-fit on the next marker refresh — used
   *  by the parent so country/region changes recenter the map, while polling
   *  updates leave the user's current zoom/pan alone. */
  fitKey?: string
}>()

const mapEl = ref<HTMLDivElement | null>(null)
let map: L.Map | null = null
let markersLayer: L.MarkerClusterGroup | null = null

const GERMANY_CENTER: [number, number] = [51.1657, 10.4515]

const runtimeConfig = useRuntimeConfig()
const countryImageryKeys = {
  fi: runtimeConfig.public.mmlApiKey,
  dk: runtimeConfig.public.datafordelerApiKey,
}

/** Mount LotPopover.vue into a fresh container that Leaflet will inject into
 *  its popup DOM. We mount lazily on popupopen (see refreshMarkers) so the
 *  lazy /api/auction-detail fetch only fires when the user actually opens
 *  the marker, not for all 2932 pins upfront. */
function mountLotPopover(el: HTMLElement, a: GeoAuction): VueApp {
  const app = createApp(LotPopover, { auction: a })
  app.mount(el)
  return app
}

// True at mount and whenever the parent bumps `fitKey` (filter change). The
// next refreshMarkers call consumes it, so polling-driven updates never reset
// the user's zoom/pan.
let shouldFitNext = true

// Markers keyed by `platform:zvgId` so refreshMarkers can diff instead of
// rebuilding — existing markers (and an open popup) survive poll updates.
const markersByKey = new Map<string, L.Marker>()

function createMarker(a: GeoAuction, lat: number, lng: number): L.Marker {
  const marker = L.marker([lat, lng], {
    icon: markerIcon,
    title: `${a.objekt ?? ''} · ${a.adresse ?? ''}`,
  })
  // Empty container; the Vue app is mounted lazily on popupopen so the
  // /api/auction-detail fetch only fires when the popup is actually opened.
  marker.bindPopup('<div class="lot-popover-mount"></div>', { maxWidth: 320, minWidth: 280 })
  let app: VueApp | null = null
  marker.on('popupopen', (e) => {
    const el = e.popup.getElement()?.querySelector('.lot-popover-mount') as HTMLElement | null
    if (!el) return
    app = mountLotPopover(el, a)
  })
  marker.on('popupclose', () => {
    if (app) {
      app.unmount()
      app = null
    }
  })
  return marker
}

function refreshMarkers(): void {
  if (!map || !markersLayer) return
  const seen = new Set<string>()
  const points: [number, number][] = []
  for (const a of props.auctions) {
    if (a.lat == null || a.lng == null) continue
    const key = `${a.platform}:${a.zvgId}`
    seen.add(key)
    if (!markersByKey.has(key)) {
      const marker = createMarker(a, a.lat, a.lng)
      marker.addTo(markersLayer)
      markersByKey.set(key, marker)
    }
    points.push([a.lat, a.lng])
  }
  // Remove markers whose auctions dropped out (removal closes an open popup,
  // which fires popupclose and unmounts its Vue app).
  for (const [key, marker] of markersByKey) {
    if (!seen.has(key)) {
      markersLayer.removeLayer(marker)
      markersByKey.delete(key)
    }
  }
  if (!shouldFitNext) return
  shouldFitNext = false
  if (points.length > 0) {
    const bounds = L.latLngBounds(points)
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 })
  } else {
    map.setView(GERMANY_CENTER, 6)
  }
}

onMounted(async () => {
  // AuctionMap is a .client.vue component that only ever mounts in response
  // to a client-side reactive change (view flips to 'map' post-hydration;
  // there's no SSR placeholder). Being an async-loaded chunk, its template
  // ref isn't attached yet on the tick onMounted first fires — Leaflet would
  // silently no-op against a null container. Await a tick so the ref is set.
  await nextTick()
  if (!mapEl.value) return
  map = L.map(mapEl.value, { scrollWheelZoom: true }).setView(GERMANY_CENTER, 6)
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
  // Free, keyless national orthophotos layered on top of Esri — each only
  // requests tiles inside its own country's bounds, so it's safe to stack
  // all of them even though this map spans many countries at once.
  const countryImagery = createAllCountryImageryLayers(countryImageryKeys)
  const satelliteOnly = L.layerGroup([esriImagery, ...countryImagery])
  const deLabels = L.tileLayer('https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png', {
    maxZoom: 18,
    opacity: 0.55,
  })
  const satelliteLabeled = L.layerGroup([esriImagery, ...countryImagery, deLabels])
  L.control
    .layers(
      { Straße: streets, 'Satellit + Beschriftung': satelliteLabeled, 'Satellit (nur Bild)': satelliteOnly },
      undefined,
      { position: 'topright' },
    )
    .addTo(map)
  // Cluster markers so only a bounded number of DOM pins render per zoom
  // level — thousands of individual markers made pan/zoom janky. Clusters
  // break apart on zoom-in; chunkedLoading keeps the initial add off the
  // main thread; at close zoom (>=16) individual pins show without clustering.
  markersLayer = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 60,
    disableClusteringAtZoom: 16,
  }).addTo(map)
  refreshMarkers()
})

onBeforeUnmount(() => {
  if (map) {
    map.remove()
    map = null
    markersLayer = null
  }
})

watch(() => props.fitKey, () => {
  shouldFitNext = true
})

watch(() => props.auctions, refreshMarkers, { deep: false })
</script>

<template>
  <div ref="mapEl" class="isolate h-full w-full rounded-xl border shadow-sm overflow-hidden" />
</template>

<style>
/* Leaflet popup styling to match shadcn-style cards */
.leaflet-popup-content-wrapper {
  border-radius: 8px;
  padding: 4px;
}
.leaflet-popup-content {
  margin: 8px 12px;
}
</style>
