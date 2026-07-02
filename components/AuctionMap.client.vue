<script setup lang="ts">
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { createApp, type App as VueApp } from 'vue'
import iconUrl from 'leaflet/dist/images/marker-icon.png'
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png'
import shadowUrl from 'leaflet/dist/images/marker-shadow.png'
import type { GeoAuction } from '~/server/api/auctions-geo.get'
import LotPopover from '~/components/LotPopover.vue'

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
let markersLayer: L.LayerGroup | null = null

const GERMANY_CENTER: [number, number] = [51.1657, 10.4515]

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

function refreshMarkers(): void {
  if (!map || !markersLayer) return
  markersLayer.clearLayers()
  const points: [number, number][] = []
  for (const a of props.auctions) {
    if (a.lat == null || a.lng == null) continue
    const marker = L.marker([a.lat, a.lng], {
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
    marker.addTo(markersLayer)
    points.push([a.lat, a.lng])
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

onMounted(() => {
  if (!mapEl.value) return
  map = L.map(mapEl.value, { scrollWheelZoom: true }).setView(GERMANY_CENTER, 6)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map)
  markersLayer = L.layerGroup().addTo(map)
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
