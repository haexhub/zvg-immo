<script setup lang="ts">
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import L from 'leaflet'
import 'leaflet.markercluster'
import { createApp, type App as VueApp } from 'vue'
import type { GeoAuction } from '~/server/api/auctions-geo.get'
import LotPopover from '~/components/LotPopover.vue'
import { auctionKey } from '~/lib/auction-key'
import { boundsForCountries } from '~/lib/country-bounds'
import { createAllCountryImageryLayers } from '~/lib/countryImagery'

type AuctionMarker = L.Marker & { auctionKey?: string }

function pinIcon(active: boolean): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<span class="auction-map-pin${active ? ' is-active' : ''}"></span>`,
    iconSize: [28, 38],
    iconAnchor: [14, 36],
    popupAnchor: [0, -34],
    tooltipAnchor: [14, -28],
  })
}

const markerIcon = pinIcon(false)
const activeMarkerIcon = pinIcon(true)

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

const mapEl = ref<HTMLDivElement | null>(null)
let map: L.Map | null = null
let markersLayer: L.MarkerClusterGroup | null = null

const GERMANY_CENTER: [number, number] = [51.1657, 10.4515]

const runtimeConfig = useRuntimeConfig()
const countryImageryKeys = {
  fi: runtimeConfig.public.mmlApiKey as string,
  dk: runtimeConfig.public.datafordelerApiKey as string,
}

const { t } = useI18n()
const intlLocale = useIntlLocale()
const { currency, eurToDisplay } = useCurrencyDisplay()

/** Mount LotPopover.vue into a fresh container that Leaflet will inject into
 *  its popup DOM. We mount lazily on popupopen (see refreshMarkers) so the
 *  lazy /api/auction-detail fetch only fires when the user actually opens
 *  the marker, not for all 2932 pins upfront. This detached app never
 *  installs the Nuxt i18n plugin, so LotPopover can't call useI18n() itself —
 *  it gets our already-bound `t`/`intlLocale` (and, for WP-7, `currency`/
 *  the pre-converted `marketValue`) as plain props instead. */
function mountLotPopover(el: HTMLElement, a: GeoAuction): VueApp {
  const app = createApp(LotPopover, {
    auction: a,
    t,
    intlLocale: intlLocale.value,
    currency: currency.value,
    convertedMarketValue: eurToDisplay(a.marketValueEur),
  })
  app.mount(el)
  return app
}

// True at mount and whenever the parent bumps `fitKey` (filter change). The
// next refreshMarkers call consumes it, so polling-driven updates never reset
// the user's zoom/pan.
let shouldFitNext = true
let fallbackFitKey: string | null = null

// Markers keyed by `platform:externalId` so refreshMarkers can diff instead of
// rebuilding — existing markers (and an open popup) survive poll updates.
const markersByKey = new Map<string, AuctionMarker>()
let lastActiveKey: string | null = null

function applyMarkerHighlight(key: string, marker: AuctionMarker): void {
  const active = key === props.activeAuctionKey
  marker.setIcon(active ? activeMarkerIcon : markerIcon)
  marker.setZIndexOffset(active ? 1000 : 0)
}

function updateMarkerHighlight(): void {
  const changedKeys = new Set([lastActiveKey, props.activeAuctionKey].filter((key): key is string => key != null))
  const changedMarkers: AuctionMarker[] = []

  for (const key of changedKeys) {
    const marker = markersByKey.get(key)
    if (!marker) continue
    applyMarkerHighlight(key, marker)
    changedMarkers.push(marker)
  }

  lastActiveKey = props.activeAuctionKey ?? null
  if (changedMarkers.length) markersLayer?.refreshClusters(changedMarkers)
}

function clusterIcon(cluster: L.MarkerCluster): L.DivIcon {
  const children = cluster.getAllChildMarkers() as AuctionMarker[]
  const active = props.activeAuctionKey != null && children.some((marker) => marker.auctionKey === props.activeAuctionKey)
  return L.divIcon({
    className: '',
    html: `<span class="auction-map-cluster${active ? ' is-active' : ''}">${cluster.getChildCount()}</span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  })
}

function createMarker(a: GeoAuction, lat: number, lng: number): AuctionMarker {
  const key = auctionKey(a)
  const active = key === props.activeAuctionKey
  const marker = L.marker([lat, lng], {
    icon: active ? activeMarkerIcon : markerIcon,
    zIndexOffset: active ? 1000 : 0,
    title: `${a.title ?? ''} · ${a.address ?? ''}`,
  }) as AuctionMarker
  if (active) lastActiveKey = key
  marker.auctionKey = key
  // Empty container; the Vue app is mounted lazily on popupopen so the
  // /api/auction-detail fetch only fires when the popup is actually opened.
  marker.bindPopup('<div class="lot-popover-mount"></div>', { maxWidth: 320, minWidth: 280 })
  let app: VueApp | null = null
  marker.on('mouseover', () => emit('auction-hover', key))
  marker.on('mouseout', () => emit('auction-hover', null))
  marker.on('click', () => emit('auction-select', key))
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

function emitBounds(): void {
  if (!map) return
  const b = map.getBounds()
  emit('bounds-change', { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() })
}

function fitFallbackView(): void {
  if (!map) return
  const bounds = boundsForCountries(props.selectedCountries ?? [])
  if (bounds) {
    map.fitBounds(bounds, { padding: [28, 28] })
  } else {
    map.setView(GERMANY_CENTER, 6)
  }
}

function refreshMarkers(): void {
  if (!map || !markersLayer) return
  const seen = new Set<string>()
  const points: [number, number][] = []
  for (const a of props.auctions) {
    if (a.lat == null || a.lng == null) continue
    const key = auctionKey(a)
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
  const currentFitKey = props.fitKey ?? ''
  const canUpgradeFallbackFit = fallbackFitKey === currentFitKey && points.length > 0
  if (!shouldFitNext && !canUpgradeFallbackFit) return
  if (points.length > 0) {
    shouldFitNext = false
    fallbackFitKey = null
    const bounds = L.latLngBounds(points)
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 })
  } else {
    shouldFitNext = false
    fallbackFitKey = currentFitKey
    fitFallbackView()
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
  // all of them even though this map spans many countries at once. Some of
  // these sources have tile-alignment bugs (opaque no-data spillover into
  // neighbouring countries) that Esri alone doesn't have, so offer a plain
  // Esri-only view as an escape hatch.
  const countryImagery = createAllCountryImageryLayers(countryImageryKeys)
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
  const satelliteCountryTiles = L.layerGroup([esriImagery, ...countryImagery, placeLabels])
  const satelliteEsriOnly = L.layerGroup([esriImagery, placeLabels])
  L.control
    .layers(
      {
        Straße: streets,
        'Satellit (Länder-Tiles)': satelliteCountryTiles,
        'Satellit (nur Esri)': satelliteEsriOnly,
      },
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
    iconCreateFunction: clusterIcon,
  }).addTo(map)
  // moveend fires for both user pan/zoom and programmatic fitBounds/setView,
  // so this single hook covers the "search re-fit → new viewport" flow too.
  map.on('moveend', emitBounds)
  refreshMarkers()
  emitBounds()
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
  fallbackFitKey = null
  refreshMarkers()
})

watch(() => props.auctions, refreshMarkers, { deep: false })
watch(() => props.activeAuctionKey, updateMarkerHighlight)
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

.auction-map-pin {
  display: block;
  width: 22px;
  height: 22px;
  border: 2px solid white;
  border-radius: 9999px 9999px 9999px 0;
  background: #2563eb;
  box-shadow: 0 2px 8px rgb(15 23 42 / 35%);
  transform: rotate(-45deg);
}

.auction-map-pin::after {
  content: '';
  position: absolute;
  inset: 5px;
  border-radius: 9999px;
  background: white;
  opacity: 0.9;
}

.auction-map-pin.is-active {
  background: #dc2626;
  box-shadow: 0 0 0 4px rgb(220 38 38 / 25%), 0 4px 12px rgb(15 23 42 / 35%);
}

.auction-map-cluster {
  display: inline-flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border: 2px solid white;
  border-radius: 9999px;
  background: #2563eb;
  color: white;
  font-size: 0.75rem;
  font-weight: 700;
  box-shadow: 0 2px 10px rgb(15 23 42 / 30%);
}

.auction-map-cluster.is-active {
  background: #dc2626;
  box-shadow: 0 0 0 5px rgb(220 38 38 / 24%), 0 4px 12px rgb(15 23 42 / 35%);
}
</style>
