<script setup lang="ts">
import type { AuctionSearchResponse, AuctionSummary } from '~/server/api/auctions.get'
import type { GeoAuction, GeoCrawlResult } from '~/server/api/auctions-geo.get'
import type { CountryEntry } from '~/server/crawlers/registry'
import { ALL_SCOPE, isAllScope } from '~/lib/auction-constants'
import { auctionKey } from '~/lib/auction-key'
import type { SavedSearch } from '~/server/api/saved-searches/index.get'
import type { WatchlistItem } from '~/server/api/watchlist/index.get'
import { useMediaQuery, refDebounced } from '@vueuse/core'
import { apiErrorMessage } from '~/lib/api-error'

definePageMeta({ layout: 'search' })

const route = useRoute()
const router = useRouter()
const { user } = useAuth()
const { t, locale } = useI18n()
const intlLocale = useIntlLocale()
const { currency, eurToDisplay, displayToEur } = useCurrencyDisplay()
const propertyTypeLabel = usePropertyTypeLabel()
const countryLabel = useCountryLabel()

// Desktop shows list + map side by side; below this breakpoint they collapse
// into the two SearchTabs panes (see template) — matches SiteHeader's own
// `md:` breakpoint. useMediaQuery reads matchMedia synchronously during setup
// on the client, i.e. before the first hydration pass — gating it behind
// `mounted` keeps that first client render identical to the SSR-safe mobile
// markup, so the desktop swap happens as a normal post-hydration update
// instead of a hydration mismatch (which otherwise corrupts the DOM).
const mediaIsDesktop = useMediaQuery('(min-width: 768px)')
const mounted = ref(false)
const isDesktop = computed(() => mounted.value && mediaIsDesktop.value)

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
const SORT_OPTIONS = ['default', 'dateAsc', 'priceAsc', 'priceDesc'] as const
type SortBy = typeof SORT_OPTIONS[number]
function querySortBy(): SortBy {
  const v = queryStr('sort', 'default')
  return SORT_OPTIONS.includes(v as SortBy) ? (v as SortBy) : 'default'
}

// Country/region multi-select filter. Empty array = aggregate over every
// registered platform across every country. Region selections are stored as
// `${countryCode}:${regionCode}` pairs (not bare region codes) since region
// codes aren't unique across countries once several countries are selectable.
const selectedCountries = ref<string[]>(queryList('country'))
const selectedRegionKeys = ref<string[]>(queryList('region'))

const filtersOpen = ref(false)

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

// Regions of the currently selected countries (empty when none selected).
// Each entry carries its country's display name so the checkbox list can
// disambiguate identically-named regions once multiple countries are picked.
const availableRegions = computed(() => {
  if (selectedCountries.value.length === 0) return []
  return (countries.value ?? [])
    .filter((c) => selectedCountries.value.includes(c.code))
    .flatMap((c) => c.regions.map((r) => ({ ...r, key: `${c.code}:${r.code}`, countryName: countryLabel(c.code, c.name) })))
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

const queryParams = computed(() => ({
  ...route.query,
  country: selectedCountries.value.length ? selectedCountries.value.join(',') : undefined,
  regionNames: selectedRegionKeys.value
    .map((key) => {
      const region = availableRegions.value.find((entry) => entry.key === key)
      return region ? `${region.country}:${region.name}` : null
    })
    .filter((value): value is string => value != null)
    .join(',') || undefined,
  page: 1,
  pageSize: 30,
}))

// Search results are filtered and paginated in Postgres. Only compact card
// summaries reach the browser; detail text, documents and galleries stay on
// the per-auction endpoint.
const { data, pending, error, refresh } = useLazyFetch<AuctionSearchResponse | null>('/api/auctions', {
  query: queryParams,
  default: () => null,
})

// SSR-safe default 'list' (see isDesktop above) — this is now purely the
// active *mobile* tab; on desktop both panes render regardless of its value.
const view = ref<'list' | 'map'>('list')
const mapViewImpliedByCountryQuery = ref(false)
let applyingImplicitMapView = false

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

onMounted(() => {
  const isMapView = route.query.view === 'map'
  const isCountryMapView = !isMapView && route.query.view === undefined && selectedCountries.value.length > 0
  mapViewImpliedByCountryQuery.value = isCountryMapView
  applyingImplicitMapView = isCountryMapView
  view.value = isMapView || isCountryMapView ? 'map' : 'list'
  if (applyingImplicitMapView) {
    void nextTick(() => {
      applyingImplicitMapView = false
    })
  }
  mounted.value = true
  // The multi-ref sync watcher below only fires on change — a stale
  // non-map `view` param (e.g. old `?view=list` links) wouldn't trigger
  // it since view.value already equals the default, so clean it up here.
  if (!isMapView && route.query.view !== undefined) {
    const query = { ...route.query }
    delete query.view
    router.replace({ query })
  }
})

onDeactivated(() => stopGeoPoll())
onActivated(() => {
  if (geocodingInProgress.value && mapVisible.value) startGeoPoll()
})
onBeforeUnmount(() => stopGeoPoll())

watch(view, () => {
  if (!mounted.value || applyingImplicitMapView) return
  mapViewImpliedByCountryQuery.value = false
})

const search = ref(queryStr('q'))
// Every keystroke re-runs filteredGeo and rebuilds thousands of map markers —
// debounce the search term so typing stays smooth. Selects/checkboxes keep
// applying instantly.
const debouncedSearch = refDebounced(search, 250)
const includeCancelled = ref(route.query.cancelled === '1')
const authorityFilter = ref<string>(queryStr('authority', ALL_SCOPE))
// Canonical filter state stays in EUR (matches marketValueEur, and keeps
// saved-search/URL query semantics stable regardless of the viewer's
// currency preference) — priceMinDisplay/priceMaxDisplay below convert only
// for the input fields the user actually types into.
const priceMin = ref<number | null>(queryNum('priceMin'))
const priceMax = ref<number | null>(queryNum('priceMax'))

function toDisplayOrNull(eur: number | null): number | null {
  if (eur == null) return null
  const d = eurToDisplay(eur)
  return d != null ? Math.round(d) : null
}
function toEurOrNull(v: unknown): number | null {
  if (typeof v !== 'number' || Number.isNaN(v)) return null
  const eur = displayToEur(v)
  return eur != null ? Math.round(eur) : null
}
const priceMinDisplay = computed<number | null>({
  get: () => toDisplayOrNull(priceMin.value),
  set: (v) => { priceMin.value = toEurOrNull(v) },
})
const priceMaxDisplay = computed<number | null>({
  get: () => toDisplayOrNull(priceMax.value),
  set: (v) => { priceMax.value = toEurOrNull(v) },
})
const landAreaMin = ref<number | null>(queryNum('landMin'))
const landAreaMax = ref<number | null>(queryNum('landMax'))
const livingAreaMin = ref<number | null>(queryNum('livMin'))
const livingAreaMax = ref<number | null>(queryNum('livMax'))
const yearBuiltMin = ref<number | null>(queryNum('yearBuiltMin'))
const yearBuiltMax = ref<number | null>(queryNum('yearBuiltMax'))
const renovationYearMin = ref<number | null>(queryNum('renovationYearMin'))
const renovationYearMax = ref<number | null>(queryNum('renovationYearMax'))
const categoryFilter = ref<string>(queryStr('category', ALL_SCOPE))
const conditionFilter = ref<string>(queryStr('condition', ALL_SCOPE))
const featuresFilter = ref<string[]>(queryList('features'))
const onlyWithPhotos = ref(route.query.photos === '1')
// Three-way: explicit '1'/'0' in the URL wins, otherwise fall back to the
// admin-configured default (hideRulesOnlyServerDefault) instead of `false` —
// unlike onlyWithPhotos/includeCancelled, "absent from the URL" doesn't mean
// "off" here.
const hideRulesOnly = ref(
  route.query.llmOnly === '1' ? true : route.query.llmOnly === '0' ? false : hideRulesOnlyServerDefault.value,
)

function setPriceBucket(min: number | null, max: number | null): void {
  priceMin.value = min
  priceMax.value = max
}

// When the user switches country/region, the previously-selected court may
// no longer exist. Reset filters that depend on the dataset.
watch([selectedCountries, selectedRegionKeys], () => {
  authorityFilter.value = ALL_SCOPE
  categoryFilter.value = ALL_SCOPE
})

const selectedCountryLabel = computed(() => {
  if (selectedCountries.value.length === 0) return t('search.europe')
  if (selectedCountries.value.length === 1) {
    const code = selectedCountries.value[0]!
    return countryLabel(code, countries.value?.find((c) => c.code === code)?.name)
  }
  return t('search.countriesCount', { count: selectedCountries.value.length })
})

const selectedRegionLabel = computed(() => {
  if (selectedRegionKeys.value.length === 0) return null
  if (selectedRegionKeys.value.length === 1) {
    return availableRegions.value.find((r) => r.key === selectedRegionKeys.value[0])?.name ?? null
  }
  return t('search.regionsCount', { count: selectedRegionKeys.value.length })
})

const headerLabel = computed(() => {
  return selectedRegionLabel.value
    ? `${selectedRegionLabel.value}, ${selectedCountryLabel.value}`
    : selectedCountryLabel.value
})

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

function clearAllFilters(): void {
  selectedCountries.value = []
  selectedRegionKeys.value = []
  search.value = ''
  authorityFilter.value = ALL_SCOPE
  priceMin.value = null
  priceMax.value = null
  landAreaMin.value = null
  landAreaMax.value = null
  livingAreaMin.value = null
  livingAreaMax.value = null
  yearBuiltMin.value = null
  yearBuiltMax.value = null
  renovationYearMin.value = null
  renovationYearMax.value = null
  categoryFilter.value = ALL_SCOPE
  conditionFilter.value = ALL_SCOPE
  featuresFilter.value = []
  onlyWithPhotos.value = false
  includeCancelled.value = false
  boundToMap.value = false
  hideRulesOnly.value = hideRulesOnlyServerDefault.value
}

// v-model.number yields '' (empty string) when the input is cleared; treat
// anything that isn't a real number as "filter not set".
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && !Number.isNaN(v) ? v : null
}

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
const boundToMap = ref(route.query.boundToMap === '1')
const sortBy = ref<SortBy>(querySortBy())

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

const activeFilterCount = computed(() => {
  let n = 0
  if (selectedCountries.value.length) n++
  if (selectedRegionKeys.value.length) n++
  if (search.value.trim()) n++
  if (!isAllScope(authorityFilter.value)) n++
  if (numOrNull(priceMin.value) != null) n++
  if (numOrNull(priceMax.value) != null) n++
  if (numOrNull(landAreaMin.value) != null) n++
  if (numOrNull(landAreaMax.value) != null) n++
  if (numOrNull(livingAreaMin.value) != null) n++
  if (numOrNull(livingAreaMax.value) != null) n++
  if (numOrNull(yearBuiltMin.value) != null) n++
  if (numOrNull(yearBuiltMax.value) != null) n++
  if (numOrNull(renovationYearMin.value) != null) n++
  if (numOrNull(renovationYearMax.value) != null) n++
  if (!isAllScope(categoryFilter.value)) n++
  if (!isAllScope(conditionFilter.value)) n++
  if (featuresFilter.value.length) n++
  if (onlyWithPhotos.value) n++
  if (includeCancelled.value) n++
  if (boundToMap.value) n++
  if (hideRulesOnly.value !== hideRulesOnlyServerDefault.value) n++
  return n
})

watch(
  [selectedCountries, selectedRegionKeys, debouncedSearch, authorityFilter, priceMin, priceMax, landAreaMin, landAreaMax, livingAreaMin, livingAreaMax, yearBuiltMin, yearBuiltMax, renovationYearMin, renovationYearMax, categoryFilter, conditionFilter, featuresFilter, onlyWithPhotos, includeCancelled, hideRulesOnly, boundToMap, sortBy, view],
  () => {
    const query: Record<string, string> = {}
    if (selectedCountries.value.length) query.country = selectedCountries.value.join(',')
    if (selectedRegionKeys.value.length) query.region = selectedRegionKeys.value.join(',')
    if (debouncedSearch.value.trim()) query.q = debouncedSearch.value.trim()
    if (!isAllScope(authorityFilter.value)) query.authority = authorityFilter.value
    if (numOrNull(priceMin.value) != null) query.priceMin = String(numOrNull(priceMin.value))
    if (numOrNull(priceMax.value) != null) query.priceMax = String(numOrNull(priceMax.value))
    if (numOrNull(landAreaMin.value) != null) query.landMin = String(numOrNull(landAreaMin.value))
    if (numOrNull(landAreaMax.value) != null) query.landMax = String(numOrNull(landAreaMax.value))
    if (numOrNull(livingAreaMin.value) != null) query.livMin = String(numOrNull(livingAreaMin.value))
    if (numOrNull(livingAreaMax.value) != null) query.livMax = String(numOrNull(livingAreaMax.value))
    if (numOrNull(yearBuiltMin.value) != null) query.yearBuiltMin = String(numOrNull(yearBuiltMin.value))
    if (numOrNull(yearBuiltMax.value) != null) query.yearBuiltMax = String(numOrNull(yearBuiltMax.value))
    if (numOrNull(renovationYearMin.value) != null) query.renovationYearMin = String(numOrNull(renovationYearMin.value))
    if (numOrNull(renovationYearMax.value) != null) query.renovationYearMax = String(numOrNull(renovationYearMax.value))
    if (!isAllScope(categoryFilter.value)) query.category = categoryFilter.value
    if (!isAllScope(conditionFilter.value)) query.condition = conditionFilter.value
    if (featuresFilter.value.length) query.features = featuresFilter.value.join(',')
    if (onlyWithPhotos.value) query.photos = '1'
    if (includeCancelled.value) query.cancelled = '1'
    if (boundToMap.value) query.boundToMap = '1'
    if (hideRulesOnly.value !== hideRulesOnlyServerDefault.value) query.llmOnly = hideRulesOnly.value ? '1' : '0'
    if (sortBy.value !== 'default') query.sort = sortBy.value
    if (view.value === 'map' && !mapViewImpliedByCountryQuery.value) query.view = 'map'
    router.replace({ query })
  },
)

// Re-sync all filter refs when the user navigates with browser Back/Forward.
// Without this watch, same-route history navigation updates route.query reactively
// but refs are only initialized once at setup, so URL and UI would diverge.
watch(() => route.query, (q) => {
  const hadCountrySelection = selectedCountries.value.length > 0
  selectedCountries.value = queryList('country')
  selectedRegionKeys.value = queryList('region')
  search.value = queryStr('q')
  includeCancelled.value = q.cancelled === '1'
  authorityFilter.value = queryStr('authority', ALL_SCOPE)
  priceMin.value = queryNum('priceMin')
  priceMax.value = queryNum('priceMax')
  landAreaMin.value = queryNum('landMin')
  landAreaMax.value = queryNum('landMax')
  livingAreaMin.value = queryNum('livMin')
  livingAreaMax.value = queryNum('livMax')
  yearBuiltMin.value = queryNum('yearBuiltMin')
  yearBuiltMax.value = queryNum('yearBuiltMax')
  renovationYearMin.value = queryNum('renovationYearMin')
  renovationYearMax.value = queryNum('renovationYearMax')
  categoryFilter.value = queryStr('category', ALL_SCOPE)
  conditionFilter.value = queryStr('condition', ALL_SCOPE)
  featuresFilter.value = queryList('features')
  onlyWithPhotos.value = q.photos === '1'
  boundToMap.value = q.boundToMap === '1'
  hideRulesOnly.value = q.llmOnly === '1' ? true : q.llmOnly === '0' ? false : hideRulesOnlyServerDefault.value
  sortBy.value = querySortBy()
  const isMapView = q.view === 'map'
  const isCountryMapView = !isMapView
    && q.view === undefined
    && selectedCountries.value.length > 0
    && (!hadCountrySelection || mapViewImpliedByCountryQuery.value)
  mapViewImpliedByCountryQuery.value = isCountryMapView
  applyingImplicitMapView = isCountryMapView
  view.value = isMapView || isCountryMapView ? 'map' : 'list'
  if (applyingImplicitMapView) {
    void nextTick(() => {
      applyingImplicitMapView = false
    })
  }
}, { deep: true })

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

// Watchlist star toggle. Keyed by `${platform}:${externalId}` → the watchlist
// row's own id (needed for the DELETE call). Loaded once per login state.
const watchlistIds = ref<Map<string, string>>(new Map())
async function loadWatchlist(): Promise<void> {
  if (!user.value) {
    watchlistIds.value = new Map()
    return
  }
  try {
    const items = await authFetch<WatchlistItem[]>('/api/watchlist')
    watchlistIds.value = new Map(items.map((i) => [auctionKey(i), i.id]))
  } catch (err) {
    listActionError.value = apiErrorMessage(err, 'Die Merkliste konnte nicht geladen werden.')
  }
}
watch(user, () => loadWatchlist(), { immediate: true })

async function toggleWatchlist(a: AuctionSummary): Promise<void> {
  if (!user.value) return
  const key = auctionKey(a)
  const existingId = watchlistIds.value.get(key)
  try {
    if (existingId) {
      await authFetch(`/api/watchlist/${existingId}`, { method: 'DELETE' })
      const next = new Map(watchlistIds.value)
      next.delete(key)
      watchlistIds.value = next
    } else {
      const item = await authFetch<WatchlistItem>('/api/watchlist', {
        method: 'POST',
        body: { platform: a.platform, externalId: a.externalId, authority: a.authority, caseNumber: a.caseNumber },
      })
      const next = new Map(watchlistIds.value)
      next.set(key, item.id)
      watchlistIds.value = next
    }
  } catch (err) {
    listActionError.value = apiErrorMessage(err, 'Die Merkliste konnte nicht geändert werden.')
  }
}
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
