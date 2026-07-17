<script setup lang="ts">
import type { Auction, CrawlResult } from '~/types/auction'
import type { GeoAuction, GeoCrawlResult } from '~/server/api/auctions-geo.get'
import type { CountryEntry } from '~/server/crawlers/registry'
import { ALL_KATEGORIEN, classifyObjekt, type ObjektKategorie } from '~/lib/objektart'
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
import { refDebounced } from '@vueuse/core'

const route = useRoute()
const router = useRouter()

function queryStr(key: string, fallback = ''): string {
  const v = route.query[key]
  return (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')) || fallback
}
function queryNum(key: string): number | null {
  const v = queryStr(key)
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function queryList(key: string): string[] {
  const v = route.query[key]
  const raw = Array.isArray(v) ? v.join(',') : (v ?? '')
  return raw ? raw.split(',').filter(Boolean) : []
}

// Country/region multi-select filter. Empty array = aggregate over every
// registered platform across every country. Region selections are stored as
// `${countryCode}:${regionCode}` pairs (not bare region codes) since region
// codes aren't unique across countries once several countries are selectable.
const selectedCountries = ref<string[]>(queryList('country'))
const selectedRegionKeys = ref<string[]>(queryList('region'))

const filtersOpen = ref(false)


const { data: countries } = await useFetch<CountryEntry[]>('/api/regions', {
  default: () => [],
})

// Regions of the currently selected countries (empty when none selected).
// Each entry carries its country's display name so the checkbox list can
// disambiguate identically-named regions once multiple countries are picked.
const availableRegions = computed(() => {
  if (selectedCountries.value.length === 0) return []
  return (countries.value ?? [])
    .filter((c) => selectedCountries.value.includes(c.code))
    .flatMap((c) => c.regions.map((r) => ({ ...r, key: `${c.code}:${r.code}`, countryName: c.name })))
})

function toggleCountry(code: string): void {
  const set = new Set(selectedCountries.value)
  if (set.has(code)) set.delete(code)
  else set.add(code)
  selectedCountries.value = [...set]
}
function toggleRegion(key: string): void {
  const set = new Set(selectedRegionKeys.value)
  if (set.has(key)) set.delete(key)
  else set.add(key)
  selectedRegionKeys.value = [...set]
}

// Drop region selections that no longer belong to a selected country — e.g.
// deselecting a country should also drop its regions.
watch(selectedCountries, () => {
  const valid = new Set(availableRegions.value.map((r) => r.key))
  selectedRegionKeys.value = selectedRegionKeys.value.filter((k) => valid.has(k))
})

// The /api/auctions and /api/auctions-geo endpoints only understand a single
// {country, region} pair (or 'all'). For an actual multi-select we fetch the
// broadest dataset that still covers every selection and filter the rest
// client-side in applyFilters() — exactly one country picked can still use
// the fast region- or country-scoped disk cache; anything broader (0 or 2+
// countries) falls back to the merged 'all' cache, which is itself disk-cached
// and fast, just less scoped.
const serverCountry = computed(() => (selectedCountries.value.length === 1 ? selectedCountries.value[0]! : 'all'))
const serverRegion = computed(() => {
  if (selectedCountries.value.length !== 1) return 'all'
  const country = selectedCountries.value[0]!
  const codes = selectedRegionKeys.value
    .filter((k) => k.startsWith(`${country}:`))
    .map((k) => k.slice(country.length + 1))
  return codes.length === 1 ? codes[0]! : 'all'
})

const queryParams = computed(() => ({
  country: serverCountry.value,
  region: serverRegion.value,
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
    country: serverCountry,
    region: serverRegion,
    fetch: computed(() => (fetchMissing.value ? '1' : '0')),
  },
  default: () => null,
  immediate: false,
})

watch(view, (v) => {
  if (v === 'map' && !geoData.value && !geoPending.value) loadGeo()
})

// While the geocode bootstrap task fills the cache server-side, the client's
// snapshot of geocodedCount is stale. Poll until every address has either
// been geocoded or definitively tried (cached-as-notFound). Ignoring
// unresolvableCount here would keep the "läuft …" spinner running forever
// against addresses Nominatim can't resolve.
const geocodingInProgress = computed(() => {
  if (!geoData.value) return false
  const done = geoData.value.geocodedCount + geoData.value.unresolvableCount
  return done < geoData.value.auctions.length
})

let geoPollTimer: ReturnType<typeof setInterval> | null = null
let pollInFlight = false
async function pollGeoOnce(): Promise<void> {
  // Direct $fetch bypasses the useFetch payload cache that holds the first
  // hydration snapshot — refresh() alone keeps returning the stale value.
  // Snapshot the selection so a stale response never overwrites data the
  // user requested for a different country/region mid-flight.
  const country = serverCountry.value
  const region = serverRegion.value
  const fetchParam = fetchMissing.value ? '1' : '0'
  pollInFlight = true
  try {
    const fresh = await $fetch<GeoCrawlResult>('/api/auctions-geo', {
      query: {
        country,
        region,
        fetch: fetchParam,
      },
      // Bypass the HTTP cache so each poll sees the growing geocode cache.
      cache: 'no-store',
    })
    if (
      country === serverCountry.value
      && region === serverRegion.value
      && fetchParam === (fetchMissing.value ? '1' : '0')
    ) {
      geoData.value = fresh
    }
  } catch {
    // Ignore transient poll errors; the next tick will retry.
  } finally {
    pollInFlight = false
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
    if (geoPending.value || pollInFlight) return
    pollGeoOnce()
  }, 15_000)
}
function stopGeoPoll(): void {
  if (geoPollTimer) {
    clearInterval(geoPollTimer)
    geoPollTimer = null
  }
}
watch([geocodingInProgress, view], ([running, v]) => {
  if (running && v === 'map') startGeoPoll()
  else stopGeoPoll()
}, { immediate: true })

onMounted(() => {
  view.value = route.query.view === 'list' ? 'list' : 'map'
})

onDeactivated(() => stopGeoPoll())
onActivated(() => {
  if (geocodingInProgress.value && view.value === 'map') startGeoPoll()
})
onBeforeUnmount(() => stopGeoPoll())

const search = ref(queryStr('q'))
// Every keystroke re-runs filteredGeo and rebuilds thousands of map markers —
// debounce the search term so typing stays smooth. Selects/checkboxes keep
// applying instantly.
const debouncedSearch = refDebounced(search, 250)
const includeAufgehoben = ref(route.query.aufgehoben === '1')
const courtFilter = ref<string>(queryStr('court', 'all'))
const priceMin = ref<number | null>(queryNum('priceMin'))
const priceMax = ref<number | null>(queryNum('priceMax'))
const landAreaMin = ref<number | null>(queryNum('landMin'))
const landAreaMax = ref<number | null>(queryNum('landMax'))
const livingAreaMin = ref<number | null>(queryNum('livMin'))
const livingAreaMax = ref<number | null>(queryNum('livMax'))
const kategorieFilter = ref<string>(queryStr('kat', 'all'))
const onlyWithPhotos = ref(route.query.photos === '1')

// When the user switches country/region, the previously-selected court may
// no longer exist. Reset filters that depend on the dataset.
watch([selectedCountries, selectedRegionKeys], () => {
  courtFilter.value = 'all'
  kategorieFilter.value = 'all'
})

const selectedCountryLabel = computed(() => {
  if (selectedCountries.value.length === 0) return 'Europa'
  if (selectedCountries.value.length === 1) {
    const code = selectedCountries.value[0]!
    return countries.value?.find((c) => c.code === code)?.name ?? code
  }
  return `${selectedCountries.value.length} Länder`
})

const selectedRegionLabel = computed(() => {
  if (selectedRegionKeys.value.length === 0) return null
  if (selectedRegionKeys.value.length === 1) {
    return availableRegions.value.find((r) => r.key === selectedRegionKeys.value[0])?.name ?? null
  }
  return `${selectedRegionKeys.value.length} Regionen`
})

const headerLabel = computed(() => {
  return selectedRegionLabel.value
    ? `${selectedRegionLabel.value}, ${selectedCountryLabel.value}`
    : selectedCountryLabel.value
})

// Matches the fetched data's `region` field (a display name, e.g. "Sachsen")
// against the selected region keys (`${countryCode}:${regionCode}` pairs) —
// needed because the API/cache only scope by a single country+region and
// selecting several regions (or several countries) requires filtering the
// broader fetch client-side.
const selectedRegionNameKeys = computed<Set<string> | null>(() => {
  if (selectedRegionKeys.value.length === 0) return null
  const set = new Set<string>()
  for (const key of selectedRegionKeys.value) {
    const r = availableRegions.value.find((r) => r.key === key)
    if (r) set.add(`${r.country}:${r.name}`)
  }
  return set
})

// Restricts to the selected countries/regions only — needed because a
// multi-select (or "all") fetch returns a broader dataset than the current
// selection. Used both as the base for the full applyFilters() pass and for
// deriving the court/Objektart filter options, which must reflect only the
// selected countries/regions, not everything that happened to be fetched.
function scopeByCountryRegion<T extends Auction>(items: T[]): T[] {
  const countrySet = selectedCountries.value.length ? new Set(selectedCountries.value) : null
  const regionSet = selectedRegionNameKeys.value
  if (!countrySet && !regionSet) return items
  return items.filter((a) => {
    if (countrySet && !countrySet.has(a.country)) return false
    if (regionSet && !regionSet.has(`${a.country}:${a.region}`)) return false
    return true
  })
}

const scopedAuctions = computed<Auction[]>(() => (data.value ? scopeByCountryRegion(data.value.auctions) : []))

const courts = computed<string[]>(() => {
  return [...new Set(scopedAuctions.value.map((a) => a.amtsgericht).filter(Boolean))].sort()
})

// Prefer the extraction pipeline's propertyType (rules + LLM, understands
// every crawled language) over classifyObjekt(a.objekt), which only matches
// German keywords — falling back to it only when extraction found nothing.
const KATEGORIE_LABEL = new Map(ALL_KATEGORIEN.map((k) => [k.id, k.label]))
function auctionKategorie(a: Auction): ObjektKategorie {
  const pt = a.extraction?.propertyType
  if (pt) return { id: pt, label: KATEGORIE_LABEL.get(pt) ?? pt }
  return classifyObjekt(a.objekt)
}

// Counts of normalized Objektart categories. Sorted by descending count so
// the most common categories show up first in the dropdown.
const kategorienMitCount = computed<{ id: string; label: string; count: number }[]>(() => {
  const counts = new Map<string, { label: string; count: number }>()
  for (const a of scopedAuctions.value) {
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
  selectedCountries.value = []
  selectedRegionKeys.value = []
  search.value = ''
  courtFilter.value = 'all'
  priceMin.value = null
  priceMax.value = null
  landAreaMin.value = null
  landAreaMax.value = null
  livingAreaMin.value = null
  livingAreaMax.value = null
  kategorieFilter.value = 'all'
  onlyWithPhotos.value = false
  includeAufgehoben.value = false
}

// v-model.number yields '' (empty string) when the input is cleared; treat
// anything that isn't a real number as "filter not set".
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && !Number.isNaN(v) ? v : null
}

function applyFilters<T extends Auction>(items: T[]): T[] {
  const q = debouncedSearch.value.trim().toLowerCase()
  const kat = kategorieFilter.value
  const min = numOrNull(priceMin.value)
  const max = numOrNull(priceMax.value)
  const landMin = numOrNull(landAreaMin.value)
  const landMax = numOrNull(landAreaMax.value)
  const livMin = numOrNull(livingAreaMin.value)
  const livMax = numOrNull(livingAreaMax.value)
  return scopeByCountryRegion(items).filter((a) => {
    if (!includeAufgehoben.value && a.aufgehoben) return false
    if (courtFilter.value !== 'all' && a.amtsgericht !== courtFilter.value) return false
    if (kat !== 'all' && auctionKategorie(a).id !== kat) return false
    if (onlyWithPhotos.value && a.fotoCount === 0) return false
    if (min != null && (a.verkehrswertEur == null || a.verkehrswertEur < min)) return false
    if (max != null && (a.verkehrswertEur == null || a.verkehrswertEur > max)) return false
    if (landMin != null || landMax != null) {
      const v = a.extraction?.landAreaSqm ?? null
      if (v == null) return false
      if (landMin != null && v < landMin) return false
      if (landMax != null && v > landMax) return false
    }
    if (livMin != null || livMax != null) {
      const v = a.extraction?.livingAreaSqm ?? null
      if (v == null) return false
      if (livMin != null && v < livMin) return false
      if (livMax != null && v > livMax) return false
    }
    if (!q) return true
    const hay = `${a.aktenzeichen} ${a.amtsgericht} ${a.objekt ?? ''} ${a.adresse ?? ''} ${a.beschreibung ?? ''}`.toLowerCase()
    return hay.includes(q)
  })
}

const filtered = computed<Auction[]>(() => {
  if (!data.value) return []
  return applyFilters(data.value.auctions)
})

// The list view used to render every filtered auction as a full card in one
// go — with the "all countries" default that's ~14.7k cards (~45MB of SSR
// HTML) before the client even hydrates and switches to the map. Page it
// instead: render a bounded slice and grow it on demand.
const LIST_PAGE_SIZE = 30
const visibleCount = ref(LIST_PAGE_SIZE)
watch(filtered, () => {
  visibleCount.value = LIST_PAGE_SIZE
})
const visibleAuctions = computed<Auction[]>(() => filtered.value.slice(0, visibleCount.value))
function loadMore(): void {
  visibleCount.value += LIST_PAGE_SIZE
}

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
  if (selectedCountries.value.length) n++
  if (selectedRegionKeys.value.length) n++
  if (search.value.trim()) n++
  if (courtFilter.value !== 'all') n++
  if (numOrNull(priceMin.value) != null) n++
  if (numOrNull(priceMax.value) != null) n++
  if (numOrNull(landAreaMin.value) != null) n++
  if (numOrNull(landAreaMax.value) != null) n++
  if (numOrNull(livingAreaMin.value) != null) n++
  if (numOrNull(livingAreaMax.value) != null) n++
  if (kategorieFilter.value !== 'all') n++
  if (onlyWithPhotos.value) n++
  if (includeAufgehoben.value) n++
  return n
})

watch(
  [selectedCountries, selectedRegionKeys, debouncedSearch, courtFilter, priceMin, priceMax, landAreaMin, landAreaMax, livingAreaMin, livingAreaMax, kategorieFilter, onlyWithPhotos, includeAufgehoben, view],
  () => {
    const query: Record<string, string> = {}
    if (selectedCountries.value.length) query.country = selectedCountries.value.join(',')
    if (selectedRegionKeys.value.length) query.region = selectedRegionKeys.value.join(',')
    if (debouncedSearch.value.trim()) query.q = debouncedSearch.value.trim()
    if (courtFilter.value !== 'all') query.court = courtFilter.value
    if (numOrNull(priceMin.value) != null) query.priceMin = String(numOrNull(priceMin.value))
    if (numOrNull(priceMax.value) != null) query.priceMax = String(numOrNull(priceMax.value))
    if (numOrNull(landAreaMin.value) != null) query.landMin = String(numOrNull(landAreaMin.value))
    if (numOrNull(landAreaMax.value) != null) query.landMax = String(numOrNull(landAreaMax.value))
    if (numOrNull(livingAreaMin.value) != null) query.livMin = String(numOrNull(livingAreaMin.value))
    if (numOrNull(livingAreaMax.value) != null) query.livMax = String(numOrNull(livingAreaMax.value))
    if (kategorieFilter.value !== 'all') query.kat = kategorieFilter.value
    if (onlyWithPhotos.value) query.photos = '1'
    if (includeAufgehoben.value) query.aufgehoben = '1'
    if (view.value === 'list') query.view = 'list'
    router.replace({ query })
  },
)

// Re-sync all filter refs when the user navigates with browser Back/Forward.
// Without this watch, same-route history navigation updates route.query reactively
// but refs are only initialized once at setup, so URL and UI would diverge.
watch(() => route.query, (q) => {
  selectedCountries.value = queryList('country')
  selectedRegionKeys.value = queryList('region')
  search.value = queryStr('q')
  includeAufgehoben.value = q.aufgehoben === '1'
  courtFilter.value = queryStr('court', 'all')
  priceMin.value = queryNum('priceMin')
  priceMax.value = queryNum('priceMax')
  landAreaMin.value = queryNum('landMin')
  landAreaMax.value = queryNum('landMax')
  livingAreaMin.value = queryNum('livMin')
  livingAreaMax.value = queryNum('livMax')
  kategorieFilter.value = queryStr('kat', 'all')
  onlyWithPhotos.value = q.photos === '1'
  view.value = q.view === 'list' ? 'list' : 'map'
}, { deep: true })

// Validate URL-restored courtFilter / kategorieFilter once data has loaded.
// Invalid values produce silent 0-result filtering otherwise.
watch(data, () => {
  if (courtFilter.value !== 'all' && !courts.value.includes(courtFilter.value)) {
    courtFilter.value = 'all'
  }
  if (kategorieFilter.value !== 'all' && !kategorienMitCount.value.some((k) => k.id === kategorieFilter.value)) {
    kategorieFilter.value = 'all'
  }
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
        <AuthStatus class="ml-auto" />
      </div>
    </header>

    <div class="shrink-0 mb-3 flex items-center justify-end gap-3">
      <div v-if="filtered.length" class="text-sm text-muted-foreground mr-auto">
        {{ filtered.length }} Treffer<span v-if="view === 'map' && geoData">
          · {{ filteredGeo.length }} auf Karte ({{ geoData.geocodedCount }}/{{ geoData.auctions.length }} geokodiert<span v-if="geoData.unresolvableCount > 0">, {{ geoData.unresolvableCount }} unauffindbar</span><span v-if="geocodingInProgress">, läuft …</span>)
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

    <section v-if="view === 'map'" class="relative flex-1 min-h-0 flex flex-col">
      <p v-if="geoError" class="py-12 text-center text-destructive">
        Fehler beim Geokodieren: {{ geoError.statusMessage || geoError.message }}
      </p>
      <template v-else>
        <!-- Mount immediately so tiles render right away; markers stream in
             as geoData arrives instead of gating the whole map behind it. -->
        <AuctionMap :auctions="filteredGeo" :fit-key="`${selectedCountries.join(',')}:${selectedRegionKeys.join(',')}`" />
        <p
          v-if="geoPending && !geoData"
          class="absolute top-3 left-1/2 -translate-x-1/2 rounded-md border bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm"
        >
          Lade Standorte …
        </p>
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
            <div class="max-h-48 overflow-y-auto rounded-md border divide-y">
              <label
                v-for="c in countries"
                :key="c.code"
                class="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/50"
              >
                <input
                  type="checkbox"
                  class="h-4 w-4 rounded border-input accent-primary"
                  :checked="selectedCountries.includes(c.code)"
                  @change="toggleCountry(c.code)"
                >
                {{ c.name }}
              </label>
            </div>
          </div>

          <div class="space-y-2">
            <label class="block text-sm font-medium">Region</label>
            <div v-if="availableRegions.length" class="max-h-48 overflow-y-auto rounded-md border divide-y">
              <label
                v-for="r in availableRegions"
                :key="r.key"
                class="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/50"
              >
                <input
                  type="checkbox"
                  class="h-4 w-4 rounded border-input accent-primary"
                  :checked="selectedRegionKeys.includes(r.key)"
                  @change="toggleRegion(r.key)"
                >
                {{ r.name }}<span v-if="selectedCountries.length > 1" class="text-muted-foreground"> ({{ r.countryName }})</span>
              </label>
            </div>
            <p v-else class="text-xs text-muted-foreground">
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
                v-model.number="landAreaMin"
                type="number"
                min="0"
                step="50"
                placeholder="von"
                class="h-9 flex-1 min-w-0 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
              <span class="text-muted-foreground">–</span>
              <input
                v-model.number="landAreaMax"
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
                v-model.number="livingAreaMin"
                type="number"
                min="0"
                step="10"
                placeholder="von"
                class="h-9 flex-1 min-w-0 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
              <span class="text-muted-foreground">–</span>
              <input
                v-model.number="livingAreaMax"
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
      v-if="selectedCountries.length === 0 && pending"
      class="mb-4 text-xs text-muted-foreground text-center"
    >
      Erstaufruf kann mehrere Minuten dauern (alle registrierten Quellen parallel)
    </p>

    <section v-if="view === 'list'" class="flex-1 min-h-0 overflow-y-auto pb-4">
    <p v-if="filtered.length === 0 && !pending" class="py-12 text-center text-muted-foreground">
      Keine Termine entsprechen den Filtern.
    </p>

    <ul v-if="filtered.length" class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <li v-for="a in visibleAuctions" :key="`${a.platform}:${a.zvgId}`">
        <article
          class="h-full flex flex-col rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden"
          :class="{ 'opacity-60': a.aufgehoben }"
        >
          <a
            v-if="a.thumbnailUrl"
            :href="a.attachments.find((x) => x.kind === 'foto')?.proxyUrl ?? a.detailUrl ?? undefined"
            target="_blank"
            rel="noopener"
            class="relative block overflow-hidden border-b group"
            :title="`${a.fotoCount} Foto${a.fotoCount === 1 ? '' : 's'} öffnen`"
          >
            <img
              :src="a.thumbnailUrl"
              loading="lazy"
              alt=""
              referrerpolicy="no-referrer"
              class="aspect-16/10 w-full object-cover transition-transform duration-200 group-hover:scale-105"
            >
            <span
              v-if="a.fotoCount > 1"
              class="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white"
            >+{{ a.fotoCount - 1 }}</span>
          </a>
          <div v-else-if="!a.aufgehoben" class="flex aspect-16/10 items-center justify-center bg-muted text-muted-foreground text-sm border-b">
            Kein Foto
          </div>

          <div class="p-4 flex-1 flex flex-col gap-2">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="rounded-md bg-secondary text-secondary-foreground px-2 py-0.5 font-medium">{{ a.amtsgericht }}</span>
              <span v-if="a.region" class="rounded-md bg-muted text-muted-foreground px-2 py-0.5">{{ a.region }}</span>
              <span v-if="a.aufgehoben" class="rounded-md bg-destructive/15 text-destructive px-2 py-0.5 font-medium">Aufgehoben</span>
              <span class="font-mono text-muted-foreground">{{ a.aktenzeichen }}</span>
            </div>
            <h2 class="text-base font-semibold leading-tight mt-1">{{ a.objekt || 'Objektart unbekannt' }}</h2>
            <p v-if="a.adresse" class="text-sm text-muted-foreground">{{ a.adresse }}</p>
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
                <dd class="font-medium tabular-nums">{{ a.verkehrswertText ?? formatEur(a.verkehrswertEur) }}</dd>
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
            <NuxtLink :to="`/objekt/${encodeURIComponent(a.platform)}/${encodeURIComponent(a.zvgId)}`" class="ml-auto text-primary hover:underline">
              Details →
            </NuxtLink>
          </footer>
        </article>
      </li>
    </ul>

    <div v-if="visibleCount < filtered.length" class="flex flex-col items-center gap-2 pt-2 pb-4">
      <p class="text-xs text-muted-foreground">{{ visibleAuctions.length }} von {{ filtered.length }} angezeigt</p>
      <button
        type="button"
        class="h-9 rounded-md border bg-card px-4 text-sm shadow-xs hover:border-primary hover:text-primary transition-colors"
        @click="loadMore"
      >
        Mehr laden
      </button>
    </div>
    </section>
  </main>
</template>
