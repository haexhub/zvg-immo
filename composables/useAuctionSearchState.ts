import { refDebounced } from '@vueuse/core'
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import { ALL_SCOPE, isAllScope } from '~/lib/auction-constants'
import { toggleInArray } from '~/lib/toggle-array'
import type { CountryEntry } from '~/server/crawlers/registry'

const SORT_OPTIONS = ['default', 'dateAsc', 'priceAsc', 'priceDesc'] as const
export type AuctionSearchSortBy = typeof SORT_OPTIONS[number]

type DisplayToEur = (amount: number) => number | null
type EurToDisplay = (amount: number) => number | null

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && !Number.isNaN(v) ? v : null
}

export function useAuctionSearchState(options: {
  countries: Ref<CountryEntry[] | null>
  hideRulesOnlyServerDefault: ComputedRef<boolean>
  eurToDisplay: EurToDisplay
  displayToEur: DisplayToEur
}) {
  const route = useRoute()
  const router = useRouter()
  const { t } = useI18n()
  const countryLabel = useCountryLabel()

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

  function querySortBy(): AuctionSearchSortBy {
    const v = queryStr('sort', 'default')
    return SORT_OPTIONS.includes(v as AuctionSearchSortBy) ? (v as AuctionSearchSortBy) : 'default'
  }

  const mounted = ref(false)
  const selectedCountries = ref<string[]>(queryList('country'))
  const selectedRegionKeys = ref<string[]>(queryList('region'))
  const filtersOpen = ref(false)
  const search = ref(queryStr('q'))
  const debouncedSearch = refDebounced(search, 250)
  const includeCancelled = ref(route.query.cancelled === '1')
  const authorityFilter = ref<string>(queryStr('authority', ALL_SCOPE))
  const priceMin = ref<number | null>(queryNum('priceMin'))
  const priceMax = ref<number | null>(queryNum('priceMax'))
  const landAreaMin = ref<number | null>(queryNum('landMin'))
  const landAreaMax = ref<number | null>(queryNum('landMax'))
  const livingAreaMin = ref<number | null>(queryNum('livMin'))
  const livingAreaMax = ref<number | null>(queryNum('livMax'))
  const yearBuiltMin = ref<number | null>(queryNum('yearBuiltMin'))
  const yearBuiltMax = ref<number | null>(queryNum('yearBuiltMax'))
  const renovationYearMin = ref<number | null>(queryNum('renovationYearMin'))
  const renovationYearMax = ref<number | null>(queryNum('renovationYearMax'))
  const nearSea = ref<number | null>(queryNum('nearSea'))
  const nearLake = ref<number | null>(queryNum('nearLake'))
  const nearRiver = ref<number | null>(queryNum('nearRiver'))
  const nearMountain = ref<number | null>(queryNum('nearMountain'))
  const nearAirport = ref<number | null>(queryNum('nearAirport'))
  const urbanRural = ref<string>(queryStr('urbanRural', ALL_SCOPE))
  const nearLat = ref<number | null>(queryNum('nearLat'))
  const nearLng = ref<number | null>(queryNum('nearLng'))
  const nearRadius = ref<number | null>(queryNum('nearRadius'))
  const categoryFilter = ref<string>(queryStr('category', ALL_SCOPE))
  const conditionFilter = ref<string>(queryStr('condition', ALL_SCOPE))
  const featuresFilter = ref<string[]>(queryList('features'))
  const onlyWithPhotos = ref(route.query.photos === '1')
  const hideRulesOnly = ref(
    route.query.llmOnly === '1' ? true : route.query.llmOnly === '0' ? false : options.hideRulesOnlyServerDefault.value,
  )
  const boundToMap = ref(route.query.boundToMap === '1')
  const sortBy = ref<AuctionSearchSortBy>(querySortBy())
  const view = ref<'list' | 'map'>('list')
  const mapViewImpliedByCountryQuery = ref(false)
  let applyingImplicitMapView = false

  const availableRegions = computed(() => {
    if (selectedCountries.value.length === 0) return []
    return (options.countries.value ?? [])
      .filter((c) => selectedCountries.value.includes(c.code))
      .flatMap((c) => c.regions.map((r) => ({ ...r, key: `${c.code}:${r.code}`, countryName: countryLabel(c.code, c.name) })))
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

  const priceMinDisplay = computed<number | null>({
    get: () => toDisplayOrNull(priceMin.value),
    set: (v) => { priceMin.value = toEurOrNull(v) },
  })
  const priceMaxDisplay = computed<number | null>({
    get: () => toDisplayOrNull(priceMax.value),
    set: (v) => { priceMax.value = toEurOrNull(v) },
  })

  const selectedCountryLabel = computed(() => {
    if (selectedCountries.value.length === 0) return t('search.europe')
    if (selectedCountries.value.length === 1) {
      const code = selectedCountries.value[0]!
      return countryLabel(code, options.countries.value?.find((c) => c.code === code)?.name)
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
    if (numOrNull(nearSea.value) != null) n++
    if (numOrNull(nearLake.value) != null) n++
    if (numOrNull(nearRiver.value) != null) n++
    if (numOrNull(nearMountain.value) != null) n++
    if (numOrNull(nearAirport.value) != null) n++
    if (!isAllScope(urbanRural.value)) n++
    if (nearLat.value != null && nearLng.value != null) n++
    if (!isAllScope(categoryFilter.value)) n++
    if (!isAllScope(conditionFilter.value)) n++
    if (featuresFilter.value.length) n++
    if (onlyWithPhotos.value) n++
    if (includeCancelled.value) n++
    if (boundToMap.value) n++
    if (hideRulesOnly.value !== options.hideRulesOnlyServerDefault.value) n++
    return n
  })

  function toDisplayOrNull(eur: number | null): number | null {
    if (eur == null) return null
    const d = options.eurToDisplay(eur)
    return d != null ? Math.round(d) : null
  }

  function toEurOrNull(v: unknown): number | null {
    if (typeof v !== 'number' || Number.isNaN(v)) return null
    const eur = options.displayToEur(v)
    return eur != null ? Math.round(eur) : null
  }

  function toggleCountry(code: string): void {
    selectedCountries.value = toggleInArray(selectedCountries.value, code)
  }

  function toggleRegion(key: string): void {
    selectedRegionKeys.value = toggleInArray(selectedRegionKeys.value, key)
  }

  function setPriceBucket(min: number | null, max: number | null): void {
    priceMin.value = min
    priceMax.value = max
  }

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
    nearSea.value = null
    nearLake.value = null
    nearRiver.value = null
    nearMountain.value = null
    nearAirport.value = null
    urbanRural.value = ALL_SCOPE
    nearLat.value = null
    nearLng.value = null
    nearRadius.value = null
    categoryFilter.value = ALL_SCOPE
    conditionFilter.value = ALL_SCOPE
    featuresFilter.value = []
    onlyWithPhotos.value = false
    includeCancelled.value = false
    boundToMap.value = false
    hideRulesOnly.value = options.hideRulesOnlyServerDefault.value
  }

  function initializeMountedState(): void {
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
    if (!isMapView && route.query.view !== undefined) {
      const query = { ...route.query }
      delete query.view
      router.replace({ query })
    }
  }

  watch(selectedCountries, () => {
    const valid = new Set(availableRegions.value.map((r) => r.key))
    selectedRegionKeys.value = selectedRegionKeys.value.filter((k) => valid.has(k))
  })

  watch(
    [selectedCountries, selectedRegionKeys],
    ([countries, regions], [prevCountries, prevRegions]) => {
      const sameCountries = countries.join(',') === (prevCountries ?? []).join(',')
      const sameRegions = regions.join(',') === (prevRegions ?? []).join(',')
      if (sameCountries && sameRegions) return
      authorityFilter.value = ALL_SCOPE
      categoryFilter.value = ALL_SCOPE
    },
  )

  watch(view, () => {
    if (!mounted.value || applyingImplicitMapView) return
    mapViewImpliedByCountryQuery.value = false
  })

  watch(
    [selectedCountries, selectedRegionKeys, debouncedSearch, authorityFilter, priceMin, priceMax, landAreaMin, landAreaMax, livingAreaMin, livingAreaMax, yearBuiltMin, yearBuiltMax, renovationYearMin, renovationYearMax, nearSea, nearLake, nearRiver, nearMountain, nearAirport, urbanRural, nearLat, nearLng, nearRadius, categoryFilter, conditionFilter, featuresFilter, onlyWithPhotos, includeCancelled, hideRulesOnly, boundToMap, sortBy, view],
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
      if (numOrNull(nearSea.value) != null) query.nearSea = String(numOrNull(nearSea.value))
      if (numOrNull(nearLake.value) != null) query.nearLake = String(numOrNull(nearLake.value))
      if (numOrNull(nearRiver.value) != null) query.nearRiver = String(numOrNull(nearRiver.value))
      if (numOrNull(nearMountain.value) != null) query.nearMountain = String(numOrNull(nearMountain.value))
      if (numOrNull(nearAirport.value) != null) query.nearAirport = String(numOrNull(nearAirport.value))
      if (!isAllScope(urbanRural.value)) query.urbanRural = urbanRural.value
      if (nearLat.value != null && nearLng.value != null) {
        query.nearLat = String(nearLat.value)
        query.nearLng = String(nearLng.value)
        query.nearRadius = String(numOrNull(nearRadius.value) ?? 25)
      }
      if (!isAllScope(categoryFilter.value)) query.category = categoryFilter.value
      if (!isAllScope(conditionFilter.value)) query.condition = conditionFilter.value
      if (featuresFilter.value.length) query.features = featuresFilter.value.join(',')
      if (onlyWithPhotos.value) query.photos = '1'
      if (includeCancelled.value) query.cancelled = '1'
      if (boundToMap.value) query.boundToMap = '1'
      if (hideRulesOnly.value !== options.hideRulesOnlyServerDefault.value) query.llmOnly = hideRulesOnly.value ? '1' : '0'
      if (sortBy.value !== 'default') query.sort = sortBy.value
      if (view.value === 'map' && !mapViewImpliedByCountryQuery.value) query.view = 'map'
      router.replace({ query })
    },
  )

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
    nearSea.value = queryNum('nearSea')
    nearLake.value = queryNum('nearLake')
    nearRiver.value = queryNum('nearRiver')
    nearMountain.value = queryNum('nearMountain')
    nearAirport.value = queryNum('nearAirport')
    urbanRural.value = queryStr('urbanRural', ALL_SCOPE)
    nearLat.value = queryNum('nearLat')
    nearLng.value = queryNum('nearLng')
    nearRadius.value = queryNum('nearRadius')
    categoryFilter.value = queryStr('category', ALL_SCOPE)
    conditionFilter.value = queryStr('condition', ALL_SCOPE)
    featuresFilter.value = queryList('features')
    onlyWithPhotos.value = q.photos === '1'
    boundToMap.value = q.boundToMap === '1'
    hideRulesOnly.value = q.llmOnly === '1' ? true : q.llmOnly === '0' ? false : options.hideRulesOnlyServerDefault.value
    sortBy.value = querySortBy()
    const isMapView = q.view === 'map'
    const isCountryMapView = !isMapView &&
      q.view === undefined &&
      selectedCountries.value.length > 0 &&
      (!hadCountrySelection || mapViewImpliedByCountryQuery.value)
    mapViewImpliedByCountryQuery.value = isCountryMapView
    applyingImplicitMapView = isCountryMapView
    view.value = isMapView || isCountryMapView ? 'map' : 'list'
    if (applyingImplicitMapView) {
      void nextTick(() => {
        applyingImplicitMapView = false
      })
    }
  }, { deep: true })

  return {
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
    priceMin,
    priceMax,
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
    nearSea,
    nearLake,
    nearRiver,
    nearMountain,
    nearAirport,
    urbanRural,
    nearLat,
    nearLng,
    nearRadius,
    categoryFilter,
    conditionFilter,
    featuresFilter,
    onlyWithPhotos,
    hideRulesOnly,
    boundToMap,
    sortBy,
    headerLabel,
    activeFilterCount,
    numOrNull,
    toggleCountry,
    toggleRegion,
    setPriceBucket,
    clearAllFilters,
    initializeMountedState,
  }
}

// layouts/search.vue owns the single instance (so its header slot and the
// page share one reactive state) and bundles in the countries list it
// already fetches for useAuctionSearchState itself — pages/search.vue injects
// this rather than calling useAuctionSearchState() or fetching /api/regions
// again.
export type AuctionSearchState = ReturnType<typeof useAuctionSearchState> & {
  countries: Ref<CountryEntry[] | null>
}
export const AUCTION_SEARCH_STATE_KEY: InjectionKey<AuctionSearchState> = Symbol('auctionSearchState')
