<script setup lang="ts">
import type { AuctionSearchResponse, AuctionSummary } from '~/server/api/auctions.get'
import type { GeoAuction, GeoCrawlResult } from '~/server/api/auctions-geo.get'
import { ALL_SCOPE, isAllScope } from '~/lib/auction-constants'
import { auctionKey } from '~/lib/auction-key'
import { useMediaQuery } from '@vueuse/core'
import { apiErrorMessage } from '~/lib/api-error'
import { AUCTION_SEARCH_STATE_KEY } from '~/composables/useAuctionSearchState'
import { AUCTION_SEARCH_RESULT_KEY } from '~/composables/useAuctionSearchResult'
import { useAuctionWatchlist } from '~/composables/useAuctionWatchlist'

definePageMeta({ layout: 'search' })

const { user } = useAuth()
const { t } = useI18n()
const intlLocale = useIntlLocale()

// Desktop shows list + map side by side; below this breakpoint they collapse
// into the two SearchTabs panes (see template) — matches SiteHeader's own
// `md:` breakpoint. useMediaQuery reads matchMedia synchronously during setup
// on the client, i.e. before the first hydration pass — gating it behind
// `mounted` keeps that first client render identical to the SSR-safe mobile
// markup, so the desktop swap happens as a normal post-hydration update
// instead of a hydration mismatch (which otherwise corrupts the DOM).
const mediaIsDesktop = useMediaQuery('(min-width: 768px)')

// layouts/search.vue owns the single useAuctionSearchState instance — its
// header slot and this page both read/write the same reactive filters.
const injectedSearchState = inject(AUCTION_SEARCH_STATE_KEY)
if (!injectedSearchState) {
  throw new Error('pages/search.vue requires the auction search state provided by layouts/search.vue')
}
const {
  mounted,
  selectedCountries,
  selectedRegionKeys,
  queryParams,
  view,
  debouncedSearch,
  authorityFilter,
  categoryFilter,
  boundToMap,
  headerLabel,
} = injectedSearchState
const isDesktop = computed(() => mounted.value && mediaIsDesktop.value)

// The main /api/auctions fetch (+ its derived courts/categories facets) lives
// in layouts/search.vue — the header's Properties popover needs the same
// facets the results list does, and a layout is the only common ancestor of
// header and page content (see useAuctionSearchResult.ts).
const injectedSearchResult = inject(AUCTION_SEARCH_RESULT_KEY)
if (!injectedSearchResult) {
  throw new Error('pages/search.vue requires the auction search result provided by layouts/search.vue')
}
const { data, pending, courts, categories: kategorienMitCount } = injectedSearchResult

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

onDeactivated(() => stopGeoPoll())
onActivated(() => {
  if (geocodingInProgress.value && mapVisible.value) startGeoPoll()
})
onBeforeUnmount(() => stopGeoPoll())

const filtered = computed<AuctionSummary[]>(() => data.value?.auctions ?? [])

// Lets the map popover show grid data (photos included) instantly for any
// marker whose auction the grid has already loaded, instead of a fallback
// fetch — see components/LotPopover.vue.
const auctionSummaries = computed(() => new Map(filtered.value.map((a) => [auctionKey(a), a])))

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

    <div class="flex-1 min-h-0">
      <div v-if="isDesktop" class="h-full flex gap-4">
        <AuctionMapPane
          class="w-2/5 min-w-88 shrink-0 min-h-0"
          :auctions="filteredGeo"
          :auction-summaries="auctionSummaries"
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
        <AuctionListPane
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
  </main>
</template>
