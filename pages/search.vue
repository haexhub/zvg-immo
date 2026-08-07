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

// Desktop shows list + map side by side; below this breakpoint they collapse
// into the two SearchTabs panes (see template) — matches the search bar's own
// `md:` popover/sheet breakpoint. useMediaQuery reads matchMedia synchronously
// during setup on the client, i.e. before the first hydration pass — gating it behind
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

const filteredGeo = computed<GeoAuction[]>(() => {
  if (!geoData.value) return []
  return geoData.value.auctions
})

// The grid is always restricted to what's inside the map's visible viewport
// (emitted by AuctionMap on moveend), once the map has reported one. Before
// that (initial render, or mobile's list tab before the map tab was ever
// opened) it falls back to the unscoped fetch above.
type MapBounds = { north: number; south: number; east: number; west: number }
const mapBounds = ref<MapBounds | null>(null)
const usingBoundedList = computed(() => mapBounds.value !== null)

// The list view used to render every filtered auction as a full card in one
// go — with the "all countries" default that's ~14.7k cards (~45MB of SSR
// HTML) before the client even hydrates and switches to the map. Page it
// instead: render a bounded slice and grow it on demand.
const LIST_PAGE_SIZE = 30
const listActionError = ref<string | null>(null)

// Fallback pagination over the unscoped fetch — same page/offset paging this
// page has always done. Only exercised while mapBounds is still null.
const loadMorePending = ref(false)
async function loadMoreUnbounded(): Promise<void> {
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

// Bounds-scoped pagination — /api/auctions filters server-side on a.lat/lng
// once north/south/east/west are present, so page 1 always matches what's on
// screen instead of hoping a relevance/date/price-ordered page happens to.
// skipFacets suppresses the courts/categories facet queries: the header's
// Properties popover already gets those from the unscoped fetch above, and
// re-deriving them on every pan/zoom would double a request that already
// opens four DB connections.
//
// Plain $fetch behind a manual watch, not useFetch: bounds only ever exist
// client-side after the map's first moveend, so there's nothing here for SSR
// to prefetch, and useFetch's own built-in reactivity to its `query` option
// would fire a second, redundant request alongside a manual one triggered
// off the same change. boundedRequestKey guards against a slow page-1
// request completing after a newer bounds/filter change already started —
// same shape as pollGeoOnce's requestQuery snapshot above.
const boundedQuery = computed(() => {
  const b = mapBounds.value
  return {
    ...queryParams.value,
    pageSize: LIST_PAGE_SIZE,
    skipFacets: '1',
    ...(b ? { north: b.north, south: b.south, east: b.east, west: b.west } : {}),
  }
})
const boundedData = ref<AuctionSearchResponse | null>(null)
const boundedPending = ref(false)
let boundedRequestKey: string | null = null

watch(boundedQuery, async (query) => {
  if (!mapBounds.value) return
  const key = JSON.stringify(query)
  boundedRequestKey = key
  boundedPending.value = true
  listActionError.value = null
  try {
    const result = await $fetch<AuctionSearchResponse>('/api/auctions', {
      query: { ...query, page: 1 },
      cache: 'no-store',
    })
    if (boundedRequestKey === key) boundedData.value = result
  } catch (err) {
    if (boundedRequestKey === key) listActionError.value = apiErrorMessage(err, 'Weitere Auktionen konnten nicht geladen werden.')
  } finally {
    if (boundedRequestKey === key) boundedPending.value = false
  }
}, { immediate: true })

const boundedLoadMorePending = ref(false)
async function loadMoreBounded(): Promise<void> {
  if (!boundedData.value || boundedLoadMorePending.value || boundedData.value.auctions.length >= boundedData.value.total) return
  const key = boundedRequestKey
  const requestQuery = { ...boundedQuery.value }
  boundedLoadMorePending.value = true
  listActionError.value = null
  try {
    const nextPage = Math.floor(boundedData.value.auctions.length / LIST_PAGE_SIZE) + 1
    const next = await $fetch<AuctionSearchResponse>('/api/auctions', {
      query: { ...requestQuery, page: nextPage },
      cache: 'no-store',
    })
    if (boundedRequestKey === key && boundedData.value) {
      boundedData.value = {
        ...next,
        auctions: [...boundedData.value.auctions, ...next.auctions],
      }
    }
  } catch (err) {
    listActionError.value = apiErrorMessage(err, 'Weitere Auktionen konnten nicht geladen werden.')
  } finally {
    boundedLoadMorePending.value = false
  }
}

const visibleAuctions = computed<AuctionSummary[]>(() =>
  usingBoundedList.value ? (boundedData.value?.auctions ?? []) : filtered.value)
const listTotalCount = computed<number>(() =>
  usingBoundedList.value ? (boundedData.value?.total ?? 0) : (data.value?.total ?? 0))
const canLoadMore = computed<boolean>(() =>
  usingBoundedList.value
    ? !!boundedData.value && boundedData.value.auctions.length < boundedData.value.total
    : !!data.value && data.value.auctions.length < data.value.total)
const listPending = computed<boolean>(() => usingBoundedList.value ? boundedPending.value : pending.value)

async function loadMore(): Promise<void> {
  if (usingBoundedList.value) await loadMoreBounded()
  else await loadMoreUnbounded()
}

// Lets the map popover show grid data (photos included) instantly for any
// marker whose auction the grid has already loaded, instead of a fallback
// fetch — see components/LotPopover.vue. Merges both fetches since either
// can hold the auction the popover is asking about.
const auctionSummaries = computed(() => {
  const map = new Map(filtered.value.map((a) => [auctionKey(a), a]))
  for (const a of boundedData.value?.auctions ?? []) map.set(auctionKey(a), a)
  return map
})

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

watch(visibleAuctions, () => {
  if (activeAuctionKey.value && !visibleAuctions.value.some((a) => auctionKey(a) === activeAuctionKey.value)) {
    hoveredAuctionKey.value = null
    selectedAuctionKey.value = null
    scrollTargetKey.value = null
  }
})

// The search term feeds the fit-key so the map re-centres on matching results —
// searching "Chemnitz" zooms the map to Chemnitz, not just the country. Country
// and region selections still recentre too.
const geoFitKey = computed(() => `${selectedCountries.value.join(',')}:${selectedRegionKeys.value.join(',')}:${debouncedSearch.value}`)

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
          :total-count="listTotalCount"
          :can-load-more="canLoadMore"
          :pending="listPending"
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
        :total-count="listTotalCount"
        :can-load-more="canLoadMore"
        :pending="listPending"
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
