<script setup lang="ts">
import type { Auction, CrawlResult } from '~/types/auction'
import type { GeoAuction, GeoCrawlResult } from '~/server/api/auctions-geo.get'
import type { CountryEntry } from '~/server/crawlers/registry'
import { classifyObjekt, ALL_KATEGORIEN } from '~/lib/objektart'
import Select from '~/components/ui/select/Select.vue'
import SelectTrigger from '~/components/ui/select/SelectTrigger.vue'
import SelectValue from '~/components/ui/select/SelectValue.vue'
import SelectContent from '~/components/ui/select/SelectContent.vue'
import SelectItem from '~/components/ui/select/SelectItem.vue'
import Sheet from '~/components/ui/sheet/Sheet.vue'
import SheetContent from '~/components/ui/sheet/SheetContent.vue'
import SheetHeader from '~/components/ui/sheet/SheetHeader.vue'
import SheetFooter from '~/components/ui/sheet/SheetFooter.vue'
import SheetTitle from '~/components/ui/sheet/SheetTitle.vue'
import SheetDescription from '~/components/ui/sheet/SheetDescription.vue'
import { ListFilter } from 'lucide-vue-next'

// Country/region cascade filter. Default 'all' = aggregate over every
// registered platform across every country.
const selectedCountry = ref<string>('all')
const selectedRegion = ref<string>('all')

const filtersOpen = ref(false)


const { data: countries } = await useFetch<CountryEntry[]>('/api/regions', {
  default: () => [],
})

// Regions of the currently selected country (empty when "Alle Länder").
const availableRegions = computed(() => {
  if (selectedCountry.value === 'all') return []
  return countries.value?.find((c) => c.code === selectedCountry.value)?.regions ?? []
})

// Reset region when country changes — old region code is irrelevant.
watch(selectedCountry, () => {
  selectedRegion.value = 'all'
})

const queryParams = computed(() => ({
  country: selectedCountry.value,
  region: selectedRegion.value,
}))

// Lazy fetch so SSR doesn't block on a cold multi-region crawl.
const { data, pending, error, refresh } = useLazyFetch<CrawlResult | null>('/api/auctions', {
  query: queryParams,
  default: () => null,
})

// Initial 'list' so SSR doesn't try to mount AuctionMap.client.vue inside an
// inactive v-if branch (which leaves the map div hollow). onMounted switches
// to 'map' below; the user sees the map straight away.
const view = ref<'list' | 'map'>('list')

// Geo-fetch is gated behind the map view but reacts to country/region changes.
// Cache-only mode loads instantly from already-geocoded addresses.
// Switching the toggle to "frisch geokodieren" hits Nominatim for missing
// addresses — slow on cold start (1 req/s) but caches future calls.
const fetchMissing = ref(false)
const {
  data: geoData,
  pending: geoPending,
  error: geoError,
  execute: loadGeo,
  refresh: refreshGeo,
} = useFetch<GeoCrawlResult | null>('/api/auctions-geo', {
  query: {
    country: selectedCountry,
    region: selectedRegion,
    fetch: computed(() => (fetchMissing.value ? '1' : '0')),
  },
  default: () => null,
  immediate: false,
})

watch(view, (v) => {
  if (v === 'map' && !geoData.value && !geoPending.value) loadGeo()
})

// While the geocode bootstrap task fills the cache server-side, the client's
// snapshot of geocodedCount is stale. Poll until cache catches up to total
// addresses, so freshly-coded markers show up without a manual refresh.
const geocodingInProgress = computed(() => {
  if (!geoData.value) return false
  return geoData.value.geocodedCount < geoData.value.auctions.length
})

let geoPollTimer: ReturnType<typeof setInterval> | null = null
async function pollGeoOnce(): Promise<void> {
  // Direct $fetch bypasses the useFetch payload cache that holds the first
  // hydration snapshot — refresh() alone keeps returning the stale value.
  try {
    const fresh = await $fetch<GeoCrawlResult>('/api/auctions-geo', {
      query: {
        country: selectedCountry.value,
        region: selectedRegion.value,
        fetch: fetchMissing.value ? '1' : '0',
      },
      // Bypass the HTTP cache so each poll sees the growing geocode cache.
      cache: 'no-store',
    })
    geoData.value = fresh
  } catch {
    // Ignore transient poll errors; the next tick will retry.
  }
}
function startGeoPoll(): void {
  if (geoPollTimer) return
  geoPollTimer = setInterval(() => {
    if (view.value !== 'map') return
    if (!geocodingInProgress.value) {
      stopGeoPoll()
      return
    }
    if (geoPending.value) return
    pollGeoOnce()
  }, 15_000)
}
function stopGeoPoll(): void {
  if (geoPollTimer) {
    clearInterval(geoPollTimer)
    geoPollTimer = null
  }
}
watch(geocodingInProgress, (running) => {
  if (running && view.value === 'map') startGeoPoll()
  else stopGeoPoll()
}, { immediate: true })

onMounted(() => {
  view.value = 'map'
})

onBeforeUnmount(() => {
  stopGeoPoll()
})

const search = ref('')
const includeAufgehoben = ref(false)
const courtFilter = ref<string>('all')
const priceMin = ref<number | null>(null)
const priceMax = ref<number | null>(null)
const kategorieFilter = ref<string>('all')
const onlyWithPhotos = ref(false)
const landMin = ref<number | null>(null)
const landMax = ref<number | null>(null)
const livingMin = ref<number | null>(null)
const livingMax = ref<number | null>(null)

// When the user switches country/region, the previously-selected court may
// no longer exist. Reset filters that depend on the dataset.
watch([selectedCountry, selectedRegion], () => {
  courtFilter.value = 'all'
  kategorieFilter.value = 'all'
})

const selectedCountryLabel = computed(() => {
  if (selectedCountry.value === 'all') return 'Europa'
  return countries.value?.find((c) => c.code === selectedCountry.value)?.name ?? selectedCountry.value
})

const selectedRegionLabel = computed(() => {
  if (selectedRegion.value === 'all') return null
  return availableRegions.value.find((r) => r.code === selectedRegion.value)?.name ?? null
})

const headerLabel = computed(() => {
  return selectedRegionLabel.value
    ? `${selectedRegionLabel.value}, ${selectedCountryLabel.value}`
    : selectedCountryLabel.value
})

const courts = computed<string[]>(() => {
  if (!data.value) return []
  return [...new Set(data.value.auctions.map((a) => a.amtsgericht).filter(Boolean))].sort()
})

const KAT_LABEL = new Map(ALL_KATEGORIEN.map((k) => [k.id, k.label]))

// Canonical category for an auction: server-extracted propertyType first,
// client-side classifier as fallback for not-yet-enriched items.
function auctionKategorie(a: Auction): { id: string; label: string } {
  const pt = a.extraction?.propertyType
  if (pt) return { id: pt, label: KAT_LABEL.get(pt) ?? pt }
  return classifyObjekt(a.objekt)
}

function detailHref(a: Auction): string {
  return `/objekt/${encodeURIComponent(a.platform)}/${encodeURIComponent(a.zvgId)}`
}

function fmtArea(n: number): string {
  return `${n.toLocaleString('de-DE', { maximumFractionDigits: 0 })} m²`
}

// Compact size facts for a card, nulls omitted.
function sizeBits(a: Auction): string[] {
  const e = a.extraction
  if (!e) return []
  const bits: string[] = []
  if (e.landAreaSqm != null) bits.push(`${fmtArea(e.landAreaSqm)} Grundstück`)
  if (e.livingAreaSqm != null) bits.push(`${fmtArea(e.livingAreaSqm)} Wohnfläche`)
  if (e.rooms != null) bits.push(`${e.rooms} Zi.`)
  if (e.units != null && e.units > 1) bits.push(`${e.units} WE`)
  return bits
}

// Counts of normalized Objektart categories. Sorted by descending count so
// the most common categories show up first in the dropdown.
const kategorienMitCount = computed<{ id: string; label: string; count: number }[]>(() => {
  if (!data.value) return []
  const counts = new Map<string, { label: string; count: number }>()
  for (const a of data.value.auctions) {
    if (a.aufgehoben) continue
    const k = auctionKategorie(a)
    const entry = counts.get(k.id)
    if (entry) entry.count++
    else counts.set(k.id, { label: k.label, count: 1 })
  }
  return [...counts.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'de'))
})

function clearAllFilters(): void {
  search.value = ''
  courtFilter.value = 'all'
  priceMin.value = null
  priceMax.value = null
  kategorieFilter.value = 'all'
  onlyWithPhotos.value = false
  includeAufgehoben.value = false
  landMin.value = null
  landMax.value = null
  livingMin.value = null
  livingMax.value = null
}

function applyFilters<T extends Auction>(items: T[]): T[] {
  const q = search.value.trim().toLowerCase()
  const kat = kategorieFilter.value
  const min = priceMin.value
  const max = priceMax.value
  return items.filter((a) => {
    if (!includeAufgehoben.value && a.aufgehoben) return false
    if (courtFilter.value !== 'all' && a.amtsgericht !== courtFilter.value) return false
    if (kat !== 'all' && auctionKategorie(a).id !== kat) return false
    if (onlyWithPhotos.value && a.fotoCount === 0) return false
    if (min != null && (a.verkehrswertEur == null || a.verkehrswertEur < min)) return false
    if (max != null && (a.verkehrswertEur == null || a.verkehrswertEur > max)) return false
    const land = a.extraction?.landAreaSqm
    if (landMin.value != null && (land == null || land < landMin.value)) return false
    if (landMax.value != null && (land == null || land > landMax.value)) return false
    const living = a.extraction?.livingAreaSqm
    if (livingMin.value != null && (living == null || living < livingMin.value)) return false
    if (livingMax.value != null && (living == null || living > livingMax.value)) return false
    if (!q) return true
    const hay = `${a.aktenzeichen} ${a.amtsgericht} ${a.objekt ?? ''} ${a.adresse ?? ''} ${a.beschreibung ?? ''}`.toLowerCase()
    return hay.includes(q)
  })
}

const filtered = computed<Auction[]>(() => {
  if (!data.value) return []
  return applyFilters(data.value.auctions)
})

const filteredGeo = computed<GeoAuction[]>(() => {
  if (!geoData.value) return []
  return applyFilters<GeoAuction>(geoData.value.auctions).filter((a) => a.lat != null && a.lng != null)
})

const totals = computed(() => {
  if (!data.value) return { gesamt: 0, aktiv: 0, aufgehoben: 0 }
  const aufgehoben = data.value.auctions.filter((a) => a.aufgehoben).length
  return {
    gesamt: data.value.auctions.length,
    aktiv: data.value.auctions.length - aufgehoben,
    aufgehoben,
  }
})

const activeFilterCount = computed(() => {
  let n = 0
  if (selectedCountry.value !== 'all') n++
  if (selectedRegion.value !== 'all') n++
  if (search.value.trim()) n++
  if (courtFilter.value !== 'all') n++
  if (priceMin.value != null) n++
  if (priceMax.value != null) n++
  if (kategorieFilter.value !== 'all') n++
  if (onlyWithPhotos.value) n++
  if (includeAufgehoben.value) n++
  if (landMin.value != null || landMax.value != null) n++
  if (livingMin.value != null || livingMax.value != null) n++
  return n
})

function formatEur(n: number | null): string {
  if (n == null) return '–'
  return n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
}

function formatDate(iso: string | null, fallback: string | null): string {
  if (!iso) return fallback ?? '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback ?? iso
  return d.toLocaleString('de-DE', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max).replace(/\s+\S*$/, '') + '…'
}

const KIND_LABEL: Record<string, string> = {
  bekanntmachung: 'Bekanntmachung',
  foto: 'Fotos',
  exposee: 'Exposé',
  gutachten: 'Gutachten',
  sonstiges: 'Anhang',
}

function attachmentLabel(att: { kind: string; label: string }): string {
  return KIND_LABEL[att.kind] ?? att.label ?? 'Anhang'
}
</script>

<template>
  <main class="h-screen flex flex-col px-4 py-3">
    <header class="shrink-0 mb-3">
      <div class="flex items-baseline gap-x-5 gap-y-1 flex-wrap">
        <h1 class="text-2xl font-bold tracking-tight">Zwangsversteigerungen {{ headerLabel }}</h1>
        <div v-if="data" class="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          <span><span class="font-semibold text-foreground">{{ totals.gesamt }}</span> gesamt</span>
          <span><span class="font-semibold text-emerald-600 dark:text-emerald-500">{{ totals.aktiv }}</span> aktiv</span>
          <span><span class="font-semibold">{{ totals.aufgehoben }}</span> aufgehoben</span>
          <span v-if="data">Stand: {{ new Date(data.fetchedAt).toLocaleString('de-DE') }}</span>
        </div>
      </div>
    </header>

    <div class="shrink-0 mb-3 flex items-center justify-end gap-3">
      <div v-if="filtered.length" class="text-sm text-muted-foreground mr-auto">
        {{ filtered.length }} Treffer<span v-if="view === 'map' && geoData">
          · {{ filteredGeo.length }} auf Karte ({{ geoData.geocodedCount }}/{{ geoData.auctions.length }} geokodiert<span v-if="geocodingInProgress">, läuft …</span>)
        </span>
      </div>
      <button
        type="button"
        class="relative h-9 inline-flex items-center gap-2 rounded-md border bg-card px-3 text-sm shadow-xs hover:border-primary hover:text-primary transition-colors"
        @click="filtersOpen = true"
      >
        <ListFilter class="h-4 w-4" />
        <span>Filter</span>
        <span
          v-if="activeFilterCount > 0"
          class="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground"
        >{{ activeFilterCount }}</span>
      </button>
      <div class="inline-flex h-9 items-center rounded-md border bg-card p-1 text-sm shadow-xs">
        <button
          class="h-7 rounded px-3 transition-colors"
          :class="view === 'map' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'"
          @click="view = 'map'"
        >Karte</button>
        <button
          class="h-7 rounded px-3 transition-colors"
          :class="view === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'"
          @click="view = 'list'"
        >Liste</button>
      </div>
    </div>

    <p v-if="pending && !data" class="py-12 text-center text-muted-foreground">Lade Daten …</p>
    <p v-else-if="error" class="py-12 text-center text-destructive">
      Fehler beim Laden: {{ error.statusMessage || error.message }}
    </p>

    <section v-if="view === 'map'" class="flex-1 min-h-0 flex flex-col">
      <p v-if="geoPending && !geoData" class="py-12 text-center text-muted-foreground">
        Lade geokodierte Daten …
      </p>
      <p v-else-if="geoError" class="py-12 text-center text-destructive">
        Fehler beim Geokodieren: {{ geoError.statusMessage || geoError.message }}
      </p>
      <template v-else-if="geoData">
        <AuctionMap :auctions="filteredGeo" :fit-key="`${selectedCountry}:${selectedRegion}`" />
      </template>
    </section>

    <Sheet v-model:open="filtersOpen">
      <SheetContent side="right" class="flex flex-col gap-0 p-0 w-full sm:max-w-md">
        <SheetHeader class="border-b px-5 py-3">
          <SheetTitle>Filter</SheetTitle>
          <SheetDescription class="sr-only">
            Versteigerungs-Inserate nach Land, Region und weiteren Kriterien einschränken.
          </SheetDescription>
        </SheetHeader>

        <div class="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <div class="space-y-2">
            <label class="block text-sm font-medium">Land</label>
            <Select v-model="selectedCountry">
              <SelectTrigger class="w-full">
                <SelectValue placeholder="Land wählen" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle Länder</SelectItem>
                <SelectItem v-for="c in countries" :key="c.code" :value="c.code">{{ c.name }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-2">
            <label class="block text-sm font-medium">Region</label>
            <Select v-model="selectedRegion" :disabled="selectedCountry === 'all' || availableRegions.length === 0">
              <SelectTrigger class="w-full">
                <SelectValue placeholder="Region wählen" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle Regionen</SelectItem>
                <SelectItem v-for="r in availableRegions" :key="r.code" :value="r.code">{{ r.name }}</SelectItem>
              </SelectContent>
            </Select>
            <p v-if="selectedCountry === 'all'" class="text-xs text-muted-foreground">
              Wähle zuerst ein Land, um Regionen zu filtern.
            </p>
          </div>

          <div class="space-y-2">
            <label class="block text-sm font-medium">Suche</label>
            <input
              v-model="search"
              type="search"
              placeholder="Ort, Aktenzeichen, Objekt, Beschreibung …"
              class="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
          </div>

          <div class="space-y-2">
            <label class="block text-sm font-medium">Gericht</label>
            <Select v-model="courtFilter">
              <SelectTrigger class="w-full">
                <SelectValue placeholder="Gericht wählen" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle Gerichte</SelectItem>
                <SelectItem v-for="c in courts" :key="c" :value="c">{{ c }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-2">
            <label class="block text-sm font-medium">Verkehrswert (€)</label>
            <div class="flex items-center gap-2">
              <input
                v-model.number="priceMin"
                type="number"
                min="0"
                step="10000"
                placeholder="von"
                class="h-9 flex-1 min-w-0 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
              <span class="text-muted-foreground">–</span>
              <input
                v-model.number="priceMax"
                type="number"
                min="0"
                step="10000"
                placeholder="bis"
                class="h-9 flex-1 min-w-0 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
            </div>
            <div class="flex flex-wrap gap-1 pt-1">
              <button
                v-for="(p, i) in [
                  { label: '≤ 100k', min: null, max: 100_000 },
                  { label: '100–300k', min: 100_000, max: 300_000 },
                  { label: '300–600k', min: 300_000, max: 600_000 },
                  { label: '≥ 600k', min: 600_000, max: null },
                ]"
                :key="i"
                type="button"
                class="rounded-full border px-3 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                @click="priceMin = p.min; priceMax = p.max"
              >{{ p.label }}</button>
            </div>
          </div>

          <div class="space-y-2">
            <label class="block text-sm font-medium">Grundstücksfläche (m²)</label>
            <div class="flex items-center gap-2">
              <input
                v-model.number="landMin"
                type="number"
                min="0"
                step="50"
                placeholder="von"
                class="h-9 flex-1 min-w-0 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
              <span class="text-muted-foreground">–</span>
              <input
                v-model.number="landMax"
                type="number"
                min="0"
                step="50"
                placeholder="bis"
                class="h-9 flex-1 min-w-0 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
            </div>
          </div>

          <div class="space-y-2">
            <label class="block text-sm font-medium">Wohnfläche (m²)</label>
            <div class="flex items-center gap-2">
              <input
                v-model.number="livingMin"
                type="number"
                min="0"
                step="10"
                placeholder="von"
                class="h-9 flex-1 min-w-0 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
              <span class="text-muted-foreground">–</span>
              <input
                v-model.number="livingMax"
                type="number"
                min="0"
                step="10"
                placeholder="bis"
                class="h-9 flex-1 min-w-0 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
            </div>
          </div>

          <div v-if="kategorienMitCount.length" class="space-y-2">
            <label class="block text-sm font-medium">Objektart</label>
            <Select v-model="kategorieFilter">
              <SelectTrigger class="w-full">
                <SelectValue placeholder="Objektart wählen" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle Objektarten</SelectItem>
                <SelectItem v-for="k in kategorienMitCount" :key="k.id" :value="k.id">
                  {{ k.label }} ({{ k.count }})
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-2 pt-2 border-t">
            <label class="flex items-center gap-2 cursor-pointer text-sm">
              <input v-model="onlyWithPhotos" type="checkbox" class="h-4 w-4 rounded border-input accent-primary"> Nur mit Fotos
            </label>
            <label class="flex items-center gap-2 cursor-pointer text-sm">
              <input v-model="includeAufgehoben" type="checkbox" class="h-4 w-4 rounded border-input accent-primary"> Aufgehobene anzeigen
            </label>
          </div>
        </div>

        <SheetFooter class="flex-row border-t px-5 py-3 sm:justify-stretch gap-2">
          <button
            type="button"
            class="flex-1 h-9 rounded-md border border-destructive px-3 text-sm text-destructive hover:bg-destructive hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-destructive"
            :disabled="activeFilterCount === 0"
            @click="clearAllFilters"
          >
            Zurücksetzen ({{ activeFilterCount }})
          </button>
          <button
            type="button"
            :disabled="pending"
            class="flex-1 h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            @click="refresh()"
          >
            {{ pending ? 'Lädt …' : 'Neu laden' }}
          </button>
        </SheetFooter>
      </SheetContent>
    </Sheet>

    <p
      v-if="selectedCountry === 'all' && pending"
      class="mb-4 text-xs text-muted-foreground text-center"
    >
      Erstaufruf kann mehrere Minuten dauern (alle registrierten Quellen parallel)
    </p>

    <section v-if="view === 'list'" class="flex-1 min-h-0 overflow-y-auto pb-4">
    <p v-if="filtered.length === 0 && !pending" class="py-12 text-center text-muted-foreground">
      Keine Termine entsprechen den Filtern.
    </p>

    <ul v-if="filtered.length" class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <li v-for="a in filtered" :key="`${a.platform}:${a.zvgId}`">
        <article
          class="h-full flex flex-col rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden transition-shadow hover:shadow-md"
          :class="{ 'opacity-60': a.aufgehoben }"
        >
          <NuxtLink
            v-if="a.thumbnailUrl"
            :to="detailHref(a)"
            class="relative block overflow-hidden border-b group"
            :title="`${a.fotoCount} Foto${a.fotoCount === 1 ? '' : 's'}`"
          >
            <img
              :src="a.thumbnailUrl"
              loading="lazy"
              alt=""
              referrerpolicy="no-referrer"
              class="aspect-[16/10] w-full object-cover transition-transform duration-200 group-hover:scale-105"
            >
            <span
              v-if="a.fotoCount > 1"
              class="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white"
            >+{{ a.fotoCount - 1 }}</span>
          </NuxtLink>
          <NuxtLink
            v-else-if="!a.aufgehoben"
            :to="detailHref(a)"
            class="flex aspect-[16/10] items-center justify-center bg-muted text-muted-foreground text-sm border-b hover:text-primary transition-colors"
          >Details öffnen</NuxtLink>

          <div class="p-4 flex-1 flex flex-col gap-2">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span
                v-if="auctionKategorie(a).id !== 'unbekannt'"
                class="rounded-md bg-primary/10 text-primary px-2 py-0.5 font-semibold"
              >{{ auctionKategorie(a).label }}</span>
              <span class="rounded-md bg-secondary text-secondary-foreground px-2 py-0.5 font-medium">{{ a.amtsgericht }}</span>
              <span v-if="a.region" class="rounded-md bg-muted text-muted-foreground px-2 py-0.5">{{ a.region }}</span>
              <span v-if="a.aufgehoben" class="rounded-md bg-destructive/15 text-destructive px-2 py-0.5 font-medium">Aufgehoben</span>
              <span class="font-mono text-muted-foreground">{{ a.aktenzeichen }}</span>
            </div>
            <h2 class="text-base font-semibold leading-tight mt-1">
              <NuxtLink :to="detailHref(a)" class="hover:text-primary transition-colors">
                {{ a.objekt || 'Objektart unbekannt' }}
              </NuxtLink>
            </h2>
            <p v-if="a.adresse" class="text-sm text-muted-foreground">{{ a.adresse }}</p>
            <p v-if="sizeBits(a).length" class="text-sm font-medium text-foreground/80">
              {{ sizeBits(a).join(' · ') }}
              <span
                v-if="a.extraction?.source === 'llm'"
                class="ml-1 align-middle rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground"
                title="Automatisch aus Dokumenten extrahiert"
              >auto</span>
            </p>
            <p v-if="a.beschreibung" class="text-sm text-muted-foreground leading-relaxed mt-1">
              {{ truncate(a.beschreibung, 220) }}
            </p>
            <dl class="grid grid-cols-2 gap-3 text-sm mt-2">
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">Termin</dt>
                <dd class="font-medium">{{ formatDate(a.terminIso, a.terminText) }}</dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-wide text-muted-foreground">Verkehrswert</dt>
                <dd class="font-medium tabular-nums">{{ formatEur(a.verkehrswertEur) }}</dd>
              </div>
            </dl>
          </div>

          <footer class="border-t px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <a v-if="a.pdfUrl" :href="a.pdfUrl" target="_blank" rel="noopener" class="text-primary hover:underline">
              Bekanntmachung
            </a>
            <a
              v-for="att in a.attachments.filter((x) => x.kind !== 'bekanntmachung')"
              :key="att.fileId"
              :href="att.proxyUrl"
              target="_blank"
              rel="noopener"
              class="text-primary hover:underline"
            >{{ attachmentLabel(att) }}</a>
            <NuxtLink :to="detailHref(a)" class="ml-auto text-primary hover:underline">
              Details →
            </NuxtLink>
          </footer>
        </article>
      </li>
    </ul>
    </section>
  </main>
</template>
