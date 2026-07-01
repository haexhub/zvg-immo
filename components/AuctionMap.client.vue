<script setup lang="ts">
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import iconUrl from 'leaflet/dist/images/marker-icon.png'
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png'
import shadowUrl from 'leaflet/dist/images/marker-shadow.png'
import type { GeoAuction } from '~/server/api/auctions-geo.get'

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

function formatEur(n: number | null): string {
  if (n == null) return '–'
  return n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
}

function formatDate(iso: string | null, fallback: string | null): string {
  if (!iso) return fallback ?? '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback ?? iso
  return d.toLocaleString('de-DE', {
    weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  })
}

function detailHref(a: GeoAuction): string {
  return `/objekt/${encodeURIComponent(a.platform)}/${encodeURIComponent(a.zvgId)}`
}

// Crawler-sourced fields (objekt, adresse, amtsgericht, aktenzeichen) come
// from foreign HTML/PDFs we don't control. Leaflet's bindPopup uses innerHTML,
// so every interpolated value must be escaped or a malformed source record
// could execute script in the user's browser.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildPopupHtml(a: GeoAuction): string {
  const href = detailHref(a) // encodeURIComponent above already makes this attribute-safe
  const thumb = a.thumbnailUrl
    ? `<a href="${href}">
         <img src="${escapeHtml(a.thumbnailUrl)}" referrerpolicy="no-referrer"
              style="width:100%;height:120px;object-fit:cover;border-radius:6px;display:block;margin-bottom:.5rem;">
       </a>`
    : ''
  const links = [
    a.pdfUrl ? `<a href="${escapeHtml(a.pdfUrl)}" target="_blank" rel="noopener">Bekanntmachung</a>` : '',
    `<a href="${href}">Details</a>`,
  ].filter(Boolean).join(' · ')
  return `
    <div style="min-width:240px;font-family:system-ui;font-size:13px;line-height:1.45;">
      ${thumb}
      <div style="font-weight:600;font-size:14px;margin-bottom:2px;">
        <a href="${href}" style="color:inherit;text-decoration:none;">${escapeHtml(a.objekt ?? 'Objekt')}</a>
      </div>
      <div style="color:#6b7280;margin-bottom:.4rem;">${escapeHtml(a.adresse ?? '')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.4rem;font-size:12px;margin-bottom:.4rem;">
        <div><div style="text-transform:uppercase;color:#6b7280;font-size:10px;">Termin</div>${escapeHtml(formatDate(a.terminIso, a.terminText))}</div>
        <div><div style="text-transform:uppercase;color:#6b7280;font-size:10px;">Verkehrswert</div>${escapeHtml(formatEur(a.verkehrswertEur))}</div>
      </div>
      <div style="font-size:12px;border-top:1px solid #e5e7eb;padding-top:.4rem;">
        <span style="color:#6b7280;">${escapeHtml(a.amtsgericht)} · ${escapeHtml(a.aktenzeichen)}</span><br>
        ${links}
      </div>
    </div>
  `
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
    marker.bindPopup(buildPopupHtml(a), { maxWidth: 300 })
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
