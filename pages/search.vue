<script setup lang="ts">
import type { AuctionSearchResponse, AuctionSummary } from '~/server/api/auctions.get'
import type { GeoAuction, GeoCrawlResult } from '~/server/api/auctions-geo.get'
import type { CountryEntry } from '~/server/crawlers/registry'
import { ALL_SCOPE, isAllScope } from '~/lib/auction-constants'
import { auctionKey } from '~/lib/auction-key'
import type { SavedSearch } from '~/server/api/saved-searches/index.get'
import { useMediaQuery } from '@vueuse/core'
import { apiErrorMessage } from '~/lib/api-error'
import { useAuctionSearchState } from '~/composables/useAuctionSearchState'
import { useAuctionWatchlist } from '~/composables/useAuctionWatchlist'

definePageMeta({ layout: 'search' })

const route = useRoute()
const { user } = useAuth()
const { t, locale } = useI18n()
const intlLocale = useIntlLocale()
const { currency, eurToDisplay, displayToEur } = useCurrencyDisplay()
const propertyTypeLabel = usePropertyTypeLabel()

// Desktop shows list + map side by side; below this breakpoint they collapse
// into the two SearchTabs panes (see template) — matches SiteHeader's own
// `md:` breakpoint. useMediaQuery reads matchMedia synchronously during setup
// on the client, i.e. before the first hydration pass — gating it behind
// `mounted` keeps that first client render identical to the SSR-safe mobile
// markup, so the desktop swap happens as a normal post-hydration update
// instead of a hydration mismatch (which otherwise corrupts the DOM).
const mediaIsDesktop = useMediaQuery('(min-width: 768px)')

const { data: countries } = await useFetch<CountryEntry[]>('/api/regions', {
  cache: 'no-store',
  default: () => [],
})

// Admin-configured default for the hideRulesOnly filter below (/settings'
// "Dashboard-Anzeige" — see server/utils/app-settings.ts's
// getHideRulesOnlyAuctions). Public endpoint outside /api/settings/ since
// every visitor, not just an admin, needs this default.
const { data: displaySettings } = await useFetch<{ hideRulesOnlyAuctions: boolean }>('/api/display-settings', {
  default: () => ({ hideRulesOnlyAuctions: true }),
})
const hideRulesOnlyServerDefault = computed(() => displaySettings.value?.hideRulesOnlyAuctions ?? true)

const {
  mounted,
  selectedCountries,
  selectedRegionKeys,
  filtersOpen,
  availableRegions,
  queryParams,
  view,
  search,
  debouncedSearch,
  includeCancelled,
  authorityFilter,
  priceMinDisplay,
  priceMaxDisplay,
  landAreaMin,
  landAreaMax,
  livingAreaMin,
  livingAreaMax,
  yearBuiltMin,
  yearBuiltMax,
  renovationYearMin,
  renovationYearMax,
  categoryFilter,
  conditionFilter,
  featuresFilter,
  onlyWithPhotos,
  hideRulesOnly,
  boundToMap,
  sortBy,
  headerLabel,
  activeFilterCount,
  toggleCountry,
  toggleRegion,
  setPriceBucket,
  clearAllFilters,
  initializeMountedState,
} = useAuctionSearchState({
  countries,
  hideRulesOnlyServerDefault,
  eurToDisplay,
  displayToEur,
})
const isDesktop = computed(() => mounted.value && mediaIsDesktop.value)

// Search results are filtered and paginated in Postgres. Only compact card
// summaries reach the browser; detail text, documents and galleries stay on
// the per-auction endpoint.
const { data, pending, error, refresh } = useLazyFetch<AuctionSearchResponse | null>('/api/auctions', {
  query: queryParams,
  default: () => null,
})

// The map pane is visible whenever it's actually on screen: always on
// desktop, or only during the "map" mobile tab. Drives both the geo-fetch
// trigger and the poll below — never true during SSR, so the map never
// mounts inside a zero-size container.
const mapVisible = computed(() => isDesktop.value || view.value === 'map')

// Geo-fetch is gated behind the map being visible but reacts to country/region
// changes. The first request stays cache-only so the map appears instantly; a
// narrowed single-country view then lets the poller ask the server to resolve
// missing coordinates in the background.
const shouldFetchMissingGeo = computed(() => selectedCountries.value.length === 1)
const {
  data: geoData,
  pending: geoPending,
  error: geoError,
  execute: loadGeo,
} = useFetch<GeoCrawlResult | null>('/api/auctions-geo', {
  query: computed(() => ({
    ...queryParams.value,
    fetch: '0',
  })),
  default: () => null,
  immediate: false,
})

watch(mapVisible, (visible) => {
  if (visible && !geoData.value && !geoPending.value) loadGeo()
}, { immediate: true })

// While the geocode bootstrap task fills the cache server-side, the client's
// snapshot of geocodedCount is stale. Poll until every address has either
// been geocoded or definitively tried (cached-as-notFound). Ignoring
// unresolvableCount here would keep the "läuft …" spinner running forever
// against addresses Nominatim can't resolve.
const geocodingInProgress = computed(() => {
  if (!geoData.value) return false
  const done = geoData.value.geocodedCount + geoData.value.unresolvableCount
  return done < geoData.value.total
})

let geoPollTimer: ReturnType<typeof setInterval> | null = null
let pollInFlight = false
const geoBackgroundError = ref<{ message: string } | null>(null)
async function pollGeoOnce(): Promise<void> {
  // Direct $fetch bypasses the useFetch payload cache that holds the first
  // hydration snapshot — refresh() alone keeps returning the stale value.
  // Snapshot the selection so a stale response never overwrites data the
  // user requested for a different country/region mid-flight.
  const requestQuery = { ...queryParams.value }
  const fetchParam = shouldFetchMissingGeo.value ? '1' : '0'
  pollInFlight = true
  geoBackgroundError.value = null
  try {
    const fresh = await $fetch<GeoCrawlResult>('/api/auctions-geo', {
      query: {
        ...requestQuery,
        fetch: fetchParam,
      },
      // Bypass the HTTP cache so each poll sees the growing geocode cache.
      cache: 'no-store',
    })
    if (
      JSON.stringify(requestQuery) === JSON.stringify(queryParams.value)
      && fetchParam === (shouldFetchMissingGeo.value ? '1' : '0')
    ) {
      geoData.value = fresh
    }
  } catch (err) {
    geoBackgroundError.value = { message: apiErrorMessage(err, t('search.geoError')) }
  } finally {
    pollInFlight = false
  }
}
function startGeoPoll(): void {
  if (geoPollTimer) return
  if (mapVisible.value && shouldFetchMissingGeo.value && geocodingInProgress.value && !geoPending.value && !pollInFlight) {
    void pollGeoOnce()
  }
  geoPollTimer = setInterval(() => {
    if (!mapVisible.value) return
    if (!shouldFetchMissingGeo.value) {
      stopGeoPoll()
      return
    }
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
watch([geocodingInProgress, mapVisible, shouldFetchMissingGeo], ([running, visible, shouldFetch]) => {
  if (running && visible && shouldFetch) startGeoPoll()
  else stopGeoPoll()
}, { immediate: true })

onMounted(initializeMountedState)

onDeactivated(() => stopGeoPoll())
onActivated(() => {
  if (geocodingInProgress.value && mapVisible.value) startGeoPoll()
})
onBeforeUnmount(() => stopGeoPoll())

const courts = computed<string[]>(() => {
  return data.value?.facets.authorities ?? []
})

// Counts of normalized Objektart categories. Sorted by descending count so
// the most common categories show up first in the dropdown.
const kategorienMitCount = computed<{ id: string; label: string; count: number }[]>(() => {
  return (data.value?.facets.categories ?? [])
    .map(({ id, count }) => ({ id, label: propertyTypeLabel(id), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, locale.value))
})

const filtered = computed<AuctionSummary[]>(() => data.value?.auctions ?? [])

const filteredGeo = computed<GeoAuction[]>(() => {
  if (!geoData.value) return []
  return geoData.value.auctions
})

// "Kartenbereich": when on, the list is restricted to auctions whose
// coordinates fall inside the map's visible viewport (emitted by AuctionMap on
// moveend). Only geocoded auctions can be placed, so ungeocoded ones drop out
// of the list while this is active.
type MapBounds = { north: number; south: number; east: number; west: number }
const mapBounds = ref<MapBounds | null>(null)

const listBase = computed<AuctionSummary[]>(() => {
  if (boundToMap.value && mapBounds.value) {
    const b = mapBounds.value
    const visibleKeys = new Set(filteredGeo.value
      .filter((a) => a.lat >= b.south && a.lat <= b.north && a.lng >= b.west && a.lng <= b.east)
      .map(auctionKey))
    return filtered.value.filter((auction) => visibleKeys.has(auctionKey(auction)))
  }
  return filtered.value
})
const sortedList = computed<AuctionSummary[]>(() => listBase.value)

// The list view used to render every filtered auction as a full card in one
// go — with the "all countries" default that's ~14.7k cards (~45MB of SSR
// HTML) before the client even hydrates and switches to the map. Page it
// instead: render a bounded slice and grow it on demand.
const LIST_PAGE_SIZE = 30
const loadMorePending = ref(false)
const listActionError = ref<string | null>(null)
const visibleAuctions = computed<AuctionSummary[]>(() => sortedList.value)
async function loadMore(): Promise<void> {
  if (!data.value || loadMorePending.value || data.value.auctions.length >= data.value.total) return
  loadMorePending.value = true
  listActionError.value = null
  try {
    const nextPage = Math.floor(data.value.auctions.length / LIST_PAGE_SIZE) + 1
    const next = await $fetch<AuctionSearchResponse>('/api/auctions', {
      query: { ...queryParams.value, page: nextPage, pageSize: LIST_PAGE_SIZE },
      cache: 'no-store',
    })
    data.value = {
      ...next,
      auctions: [...data.value.auctions, ...next.auctions],
    }
  } catch (err) {
    listActionError.value = apiErrorMessage(err, 'Weitere Auktionen konnten nicht geladen werden.')
  } finally {
    loadMorePending.value = false
  }
}

const hoveredAuctionKey = ref<string | null>(null)
const selectedAuctionKey = ref<string | null>(null)
const scrollTargetKey = ref<string | null>(null)
const activeAuctionKey = computed(() => hoveredAuctionKey.value ?? selectedAuctionKey.value)

// The list renders the whole server page, so revealing an auction is just a
// scroll — no visibleCount growing like the client-side paging used to need.
function revealAuctionInList(key: string): void {
  scrollTargetKey.value = key
}

function setAuctionHover(key: string | null): void {
  hoveredAuctionKey.value = key
}

function handleMapAuctionHover(key: string | null): void {
  hoveredAuctionKey.value = key
  if (key) revealAuctionInList(key)
}

function handleMapAuctionSelect(key: string): void {
  selectedAuctionKey.value = key
  revealAuctionInList(key)
}

watch(sortedList, () => {
  if (activeAuctionKey.value && !sortedList.value.some((a) => auctionKey(a) === activeAuctionKey.value)) {
    hoveredAuctionKey.value = null
    selectedAuctionKey.value = null
    scrollTargetKey.value = null
  }
})

// The search term feeds the fit-key so the map re-centres on matching results —
// searching "Chemnitz" zooms the map to Chemnitz, not just the country. Country
// and region selections still recentre too.
const geoFitKey = computed(() => `${selectedCountries.value.join(',')}:${selectedRegionKeys.value.join(',')}:${debouncedSearch.value}`)

const totals = computed(() => {
  if (!data.value) return { gesamt: 0, aktiv: 0, cancelled: 0 }
  return {
    gesamt: data.value.total,
    aktiv: data.value.active,
    cancelled: data.value.cancelled,
  }
})

// Validate URL-restored authorityFilter / categoryFilter once data has loaded.
// Invalid values produce silent 0-result filtering otherwise.
watch(data, () => {
  if (!isAllScope(authorityFilter.value) && !courts.value.includes(authorityFilter.value)) {
    authorityFilter.value = ALL_SCOPE
  }
  if (!isAllScope(categoryFilter.value) && !kategorienMitCount.value.some((k) => k.id === categoryFilter.value)) {
    categoryFilter.value = ALL_SCOPE
  }
})

// "Suche speichern" — POSTs the current URL query params as-is (same shape
// saved_searches.filters mirrors, see lib/auction-filters.ts) under a
// user-chosen name.
const savingSearch = ref(false)
async function saveCurrentSearch(): Promise<void> {
  if (!user.value) return
  const name = window.prompt(t('search.saveSearchPrompt'))?.trim()
  if (!name) return
  savingSearch.value = true
  try {
    await authFetch<SavedSearch>('/api/saved-searches', {
      method: 'POST',
      body: { name, filters: route.query },
    })
  } catch (err: unknown) {
    const msg = (err as { statusMessage?: string; message?: string })?.statusMessage
      ?? (err as { message?: string })?.message
      ?? t('search.saveSearchError')
    window.alert(msg)
  } finally {
    savingSearch.value = false
  }
}

const { watchlistIds, toggleWatchlist } = useAuctionWatchlist({
  onError: (message) => {
    listActionError.value = message
  },
})
</script>

<template>
  <main class="h-full flex flex-col px-4 py-3">
    <header class="shrink-0 mb-3">
      <div class="flex items-baseline gap-x-5 gap-y-1 flex-wrap">
        <h1 class="text-2xl font-bold tracking-tight">{{ $t('search.titleWithLabel', { label: headerLabel }) }}</h1>
        <div v-if="data" class="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          <span><span class="font-semibold text-foreground">{{ totals.gesamt }}</span> {{ $t('search.total') }}</span>
          <span><span class="font-semibold text-emerald-600 dark:text-emerald-500">{{ totals.aktiv }}</span> {{ $t('search.active') }}</span>
          <span><span class="font-semibold">{{ totals.cancelled }}</span> {{ $t('search.cancelled') }}</span>
          <span v-if="data">{{ $t('search.asOf', { date: new Date(data.fetchedAt).toLocaleString(intlLocale) }) }}</span>
        </div>
      </div>
    </header>

    <SearchToolbar
      v-model:search="search"
      v-model:sort-by="sortBy"
      v-model:bound-to-map="boundToMap"
      :filtered-count="data?.total ?? 0"
      :geo-data="geoData"
      :filtered-geo-count="filteredGeo.length"
      :geocoding-in-progress="geocodingInProgress"
      :logged-in="!!user"
      :saving-search="savingSearch"
      :active-filter-count="activeFilterCount"
      @save-search="saveCurrentSearch"
      @open-filters="filtersOpen = true"
    />

    <p v-if="pending && !data" class="py-12 text-center text-muted-foreground">{{ $t('search.loadingData') }}</p>
    <p v-else-if="error" class="py-12 text-center text-destructive">
      {{ $t('search.loadError', { msg: error.statusMessage || error.message }) }}
    </p>
    <p v-if="listActionError" role="alert" class="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {{ listActionError }}
    </p>
    <p
      v-if="selectedCountries.length === 0 && pending"
      class="mb-4 text-xs text-muted-foreground text-center"
    >
      {{ $t('search.initialLoadHint') }}
    </p>

    <div class="flex-1 min-h-0">
      <div v-if="isDesktop" class="h-full flex gap-4">
        <SearchAuctionMapPane
          class="w-2/5 min-w-88 shrink-0 min-h-0"
          :auctions="filteredGeo"
          :selected-countries="selectedCountries"
          :fit-key="geoFitKey"
          :geo-pending="geoPending"
          :has-geo-data="!!geoData"
          :geo-error="geoError ?? geoBackgroundError"
          :active-auction-key="activeAuctionKey"
          @bounds-change="mapBounds = $event"
          @auction-hover="handleMapAuctionHover"
          @auction-select="handleMapAuctionSelect"
        />
        <SearchAuctionListPane
          class="flex-1 min-h-0"
          :auctions="visibleAuctions"
          :total-count="boundToMap ? sortedList.length : (data?.total ?? 0)"
          :pending="pending"
          :logged-in="!!user"
          :watchlist-ids="watchlistIds"
          :active-auction-key="activeAuctionKey"
          :scroll-target-key="scrollTargetKey"
          @toggle-watchlist="toggleWatchlist"
          @load-more="loadMore"
          @auction-hover="setAuctionHover"
        />
      </div>
      <SearchTabs
        v-else
        v-model="view"
        :auctions="visibleAuctions"
        :total-count="boundToMap ? sortedList.length : (data?.total ?? 0)"
        :pending="pending"
        :logged-in="!!user"
        :watchlist-ids="watchlistIds"
        :active-auction-key="activeAuctionKey"
        :scroll-target-key="scrollTargetKey"
        :geo-auctions="filteredGeo"
        :selected-countries="selectedCountries"
        :geo-fit-key="geoFitKey"
        :geo-pending="geoPending"
        :geo-data="geoData"
        :geo-error="geoError ?? geoBackgroundError"
        @toggle-watchlist="toggleWatchlist"
        @load-more="loadMore"
        @bounds-change="mapBounds = $event"
        @auction-hover="handleMapAuctionHover"
        @auction-select="handleMapAuctionSelect"
      />
    </div>

    <Sheet v-model:open="filtersOpen">
      <SheetContent side="right" class="flex flex-col gap-0 p-0 w-full sm:max-w-md">
        <SearchFilters
          v-model:authority-filter="authorityFilter"
          v-model:price-min-display="priceMinDisplay"
          v-model:price-max-display="priceMaxDisplay"
          v-model:land-area-min="landAreaMin"
          v-model:land-area-max="landAreaMax"
          v-model:living-area-min="livingAreaMin"
          v-model:living-area-max="livingAreaMax"
          v-model:year-built-min="yearBuiltMin"
          v-model:year-built-max="yearBuiltMax"
          v-model:renovation-year-min="renovationYearMin"
          v-model:renovation-year-max="renovationYearMax"
          v-model:category-filter="categoryFilter"
          v-model:condition-filter="conditionFilter"
          v-model:features-filter="featuresFilter"
          v-model:only-with-photos="onlyWithPhotos"
          v-model:include-cancelled="includeCancelled"
          v-model:hide-rules-only="hideRulesOnly"
          :countries="countries ?? []"
          :selected-countries="selectedCountries"
          :available-regions="availableRegions"
          :selected-region-keys="selectedRegionKeys"
          :courts="courts"
          :categories="kategorienMitCount"
          :currency="currency"
          :pending="pending"
          :active-filter-count="activeFilterCount"
          @toggle-country="toggleCountry"
          @toggle-region="toggleRegion"
          @set-price-bucket="setPriceBucket"
          @clear-filters="clearAllFilters"
          @reload="refresh()"
        />
      </SheetContent>
    </Sheet>
  </main>
</template>
