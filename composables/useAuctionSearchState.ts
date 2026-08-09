import { refDebounced } from '@vueuse/core'
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import { ALL_SCOPE, isAllScope } from '~/lib/auction-constants'
import { toggleInArray } from '~/lib/toggle-array'
import {
  activeAuctionSearchFilterCount,
  defaultAuctionSearchFilters,
  parseAuctionSearchFilters,
  serializeAuctionSearchFilters,
  type AuctionSearchFilters,
  type AuctionSearchSortBy,
} from '~/lib/auction-search-filter-contract'
import type { CountryEntry } from '~/server/crawlers/registry'

export type { AuctionSearchSortBy } from '~/lib/auction-search-filter-contract'

type DisplayToEur = (amount: number) => number | null
type EurToDisplay = (amount: number) => number | null

function numOrNull(v: unknown): number | null { return typeof v === 'number' && !Number.isNaN(v) ? v : null }

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

  const initialFilters = parseAuctionSearchFilters(route.query, options.hideRulesOnlyServerDefault.value)

  const mounted = ref(false)
  const selectedCountries = ref<string[]>(initialFilters.countries)
  const selectedRegionKeys = ref<string[]>(initialFilters.regionKeys)
  const filtersOpen = ref(false)
  const search = ref(initialFilters.search)
  const debouncedSearch = refDebounced(search, 250)
  const includeCancelled = ref(initialFilters.includeCancelled)
  const authorityFilter = ref<string>(initialFilters.authority)
  const priceMin = ref<number | null>(initialFilters.priceMin)
  const priceMax = ref<number | null>(initialFilters.priceMax)
  const landAreaMin = ref<number | null>(initialFilters.landMin)
  const landAreaMax = ref<number | null>(initialFilters.landMax)
  const livingAreaMin = ref<number | null>(initialFilters.livMin)
  const livingAreaMax = ref<number | null>(initialFilters.livMax)
  const yearBuiltMin = ref<number | null>(initialFilters.yearBuiltMin)
  const yearBuiltMax = ref<number | null>(initialFilters.yearBuiltMax)
  const renovationYearMin = ref<number | null>(initialFilters.renovationYearMin)
  const renovationYearMax = ref<number | null>(initialFilters.renovationYearMax)
  const nearSea = ref<number | null>(initialFilters.nearSea)
  const nearLake = ref<number | null>(initialFilters.nearLake)
  const nearRiver = ref<number | null>(initialFilters.nearRiver)
  const nearMountain = ref<number | null>(initialFilters.nearMountain)
  const nearAirport = ref<number | null>(initialFilters.nearAirport)
  const nearSki = ref<number | null>(initialFilters.nearSki)
  const urbanRural = ref<string>(initialFilters.urbanRural)
  const nearLat = ref<number | null>(initialFilters.nearLat)
  const nearLng = ref<number | null>(initialFilters.nearLng)
  const nearRadius = ref<number | null>(initialFilters.nearRadius)
  const categoryFilter = ref<string>(initialFilters.category)
  const conditionFilter = ref<string>(initialFilters.condition)
  const featuresFilter = ref<string[]>(initialFilters.features)
  const onlyWithPhotos = ref(initialFilters.onlyWithPhotos)
  const hideRulesOnly = ref(initialFilters.hideRulesOnly)
  const sortBy = ref<AuctionSearchSortBy>(initialFilters.sortBy)
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

  function currentFilters(searchValue = search.value): AuctionSearchFilters {
    return {
      countries: selectedCountries.value, regionKeys: selectedRegionKeys.value, search: searchValue,
      authority: authorityFilter.value, priceMin: priceMin.value, priceMax: priceMax.value,
      landMin: landAreaMin.value, landMax: landAreaMax.value, livMin: livingAreaMin.value, livMax: livingAreaMax.value,
      yearBuiltMin: yearBuiltMin.value, yearBuiltMax: yearBuiltMax.value,
      renovationYearMin: renovationYearMin.value, renovationYearMax: renovationYearMax.value,
      nearSea: nearSea.value, nearLake: nearLake.value, nearRiver: nearRiver.value,
      nearMountain: nearMountain.value, nearAirport: nearAirport.value, nearSki: nearSki.value,
      urbanRural: urbanRural.value, nearLat: nearLat.value, nearLng: nearLng.value, nearRadius: nearRadius.value,
      category: categoryFilter.value, condition: conditionFilter.value, features: featuresFilter.value,
      onlyWithPhotos: onlyWithPhotos.value, includeCancelled: includeCancelled.value,
      hideRulesOnly: hideRulesOnly.value, sortBy: sortBy.value,
    }
  }

  function applyFilters(filters: AuctionSearchFilters): void {
    selectedCountries.value = filters.countries; selectedRegionKeys.value = filters.regionKeys; search.value = filters.search
    authorityFilter.value = filters.authority; priceMin.value = filters.priceMin; priceMax.value = filters.priceMax
    landAreaMin.value = filters.landMin; landAreaMax.value = filters.landMax; livingAreaMin.value = filters.livMin; livingAreaMax.value = filters.livMax
    yearBuiltMin.value = filters.yearBuiltMin; yearBuiltMax.value = filters.yearBuiltMax
    renovationYearMin.value = filters.renovationYearMin; renovationYearMax.value = filters.renovationYearMax
    nearSea.value = filters.nearSea; nearLake.value = filters.nearLake; nearRiver.value = filters.nearRiver
    nearMountain.value = filters.nearMountain; nearAirport.value = filters.nearAirport; nearSki.value = filters.nearSki
    urbanRural.value = filters.urbanRural; nearLat.value = filters.nearLat; nearLng.value = filters.nearLng; nearRadius.value = filters.nearRadius
    categoryFilter.value = filters.category; conditionFilter.value = filters.condition; featuresFilter.value = filters.features
    onlyWithPhotos.value = filters.onlyWithPhotos; includeCancelled.value = filters.includeCancelled
    hideRulesOnly.value = filters.hideRulesOnly; sortBy.value = filters.sortBy
  }

  const activeFilterCount = computed(() => activeAuctionSearchFilterCount(currentFilters(), options.hideRulesOnlyServerDefault.value))

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
    applyFilters(defaultAuctionSearchFilters(options.hideRulesOnlyServerDefault.value))
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
    [selectedCountries, selectedRegionKeys, debouncedSearch, authorityFilter, priceMin, priceMax, landAreaMin, landAreaMax, livingAreaMin, livingAreaMax, yearBuiltMin, yearBuiltMax, renovationYearMin, renovationYearMax, nearSea, nearLake, nearRiver, nearMountain, nearAirport, nearSki, urbanRural, nearLat, nearLng, nearRadius, categoryFilter, conditionFilter, featuresFilter, onlyWithPhotos, includeCancelled, hideRulesOnly, sortBy, view],
    () => {
      const query = serializeAuctionSearchFilters(currentFilters(debouncedSearch.value), options.hideRulesOnlyServerDefault.value)
      if (view.value === 'map' && !mapViewImpliedByCountryQuery.value) query.view = 'map'
      router.replace({ query })
    },
  )

  watch(() => route.query, (q) => {
    const hadCountrySelection = selectedCountries.value.length > 0
    applyFilters(parseAuctionSearchFilters(q, options.hideRulesOnlyServerDefault.value))
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
    nearSki,
    urbanRural,
    nearLat,
    nearLng,
    nearRadius,
    categoryFilter,
    conditionFilter,
    featuresFilter,
    onlyWithPhotos,
    hideRulesOnly,
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
