<script setup lang="ts">
// Airbnb-style search bar: Location / Properties / Environment, each its own
// popover — replaces the old SearchFilterBar (free-text + a button that just
// forwarded to the Sheet sidebar). Rendered into SiteHeader's search row by
// layouts/landing.vue and layouts/search.vue, each wiring it to its own filter
// state (a real useAuctionSearchState instance on the search page, a lighter
// local one on the landing page).
import { ALL_SCOPE } from '~/lib/auction-constants'
import type { CountryEntry } from '~/server/crawlers/registry'

const props = defineProps<{
  locationSummary: string
  countries: CountryEntry[]
  selectedCountries: string[]
  availableRegions: Array<{ key: string; name: string; countryName: string }>
  selectedRegionKeys: string[]
  categories: Array<{ id: string; label: string; count: number }>
  currency: string
}>()

const emit = defineEmits<{
  (e: 'toggle-country', code: string): void
  (e: 'toggle-region', key: string): void
  (e: 'select-country', code: string): void
  (e: 'set-nearby', lat: number, lng: number): void
  (e: 'pick-recent', query: Record<string, string>): void
}>()

const search = defineModel<string>('search', { required: true })

const priceMin = defineModel<number | null>('priceMin', { required: true })
const priceMax = defineModel<number | null>('priceMax', { required: true })
const landAreaMin = defineModel<number | null>('landAreaMin', { required: true })
const landAreaMax = defineModel<number | null>('landAreaMax', { required: true })
const livingAreaMin = defineModel<number | null>('livingAreaMin', { required: true })
const livingAreaMax = defineModel<number | null>('livingAreaMax', { required: true })
const yearBuiltMin = defineModel<number | null>('yearBuiltMin', { required: true })
const yearBuiltMax = defineModel<number | null>('yearBuiltMax', { required: true })
const renovationYearMin = defineModel<number | null>('renovationYearMin', { required: true })
const renovationYearMax = defineModel<number | null>('renovationYearMax', { required: true })
const authorityFilter = defineModel<string>('authorityFilter', { required: true })
const categoryFilter = defineModel<string>('categoryFilter', { required: true })
const platformFilter = defineModel<string[]>('platformFilter', { required: true })
const conditionFilter = defineModel<string[]>('conditionFilter', { required: true })
const featuresFilter = defineModel<string[]>('featuresFilter', { required: true })
const onlyWithPhotos = defineModel<boolean>('onlyWithPhotos', { required: true })
const includeCancelled = defineModel<boolean>('includeCancelled', { required: true })
const hideRulesOnly = defineModel<boolean>('hideRulesOnly', { required: true })

const nearSea = defineModel<number | null>('nearSea', { required: true })
const nearLake = defineModel<number | null>('nearLake', { required: true })
const nearRiver = defineModel<number | null>('nearRiver', { required: true })
const nearMountain = defineModel<number | null>('nearMountain', { required: true })
const nearAirport = defineModel<number | null>('nearAirport', { required: true })
const nearSkiDownhill = defineModel<number | null>('nearSkiDownhill', { required: true })
const nearSkiNordic = defineModel<number | null>('nearSkiNordic', { required: true })
const urbanRural = defineModel<string>('urbanRural', { required: true })

// Shrinks to three plain buttons once SiteHeader collapses on scroll.
const compact = useHeaderCompact()

type Segment = 'location' | 'properties' | 'environment' | null
const activeSegment = ref<Segment>(null)
function segmentOpen(segment: Segment) {
  return computed<boolean>({
    get: () => activeSegment.value === segment,
    set: (open) => { activeSegment.value = open ? segment : null },
  })
}
const locationOpen = segmentOpen('location')
const propertiesOpen = segmentOpen('properties')
const environmentOpen = segmentOpen('environment')

function handleSetNearby(lat: number, lng: number): void {
  emit('set-nearby', lat, lng)
}

// `locationSummary` already falls back to a placeholder ("Ort, Region oder
// Land suchen") resp. to "Europa" on the search page — too long, and not a
// selection, for the compact button. It tracks the same two inputs this reads.
const locationHasValue = computed(() => props.selectedCountries.length > 0 || search.value.trim().length > 0)

// Every registered platform, deduped by id — the same registry data already
// reaches this component for the region picker, so the origin filter needs
// no extra fetch of its own.
const platformOptions = computed(() => {
  const byId = new Map<string, string>()
  for (const country of props.countries) {
    for (const region of country.regions) {
      for (const platform of region.platforms) byId.set(platform.id, platform.name)
    }
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
})

const propertiesSummary = computed(() => {
  let n = 0
  if (authorityFilter.value !== ALL_SCOPE) n++
  if (platformFilter.value.length) n++
  if (priceMin.value != null) n++
  if (priceMax.value != null) n++
  if (landAreaMin.value != null) n++
  if (landAreaMax.value != null) n++
  if (livingAreaMin.value != null) n++
  if (livingAreaMax.value != null) n++
  if (yearBuiltMin.value != null) n++
  if (yearBuiltMax.value != null) n++
  if (renovationYearMin.value != null) n++
  if (renovationYearMax.value != null) n++
  if (categoryFilter.value !== ALL_SCOPE) n++
  if (conditionFilter.value.length) n++
  if (featuresFilter.value.length) n++
  if (onlyWithPhotos.value) n++
  if (includeCancelled.value) n++
  return n
})
const environmentSummary = computed(() => {
  let n = 0
  if (nearSea.value != null) n++
  if (nearLake.value != null) n++
  if (nearRiver.value != null) n++
  if (nearMountain.value != null) n++
  if (nearAirport.value != null) n++
  if (nearSkiDownhill.value != null) n++
  if (nearSkiNordic.value != null) n++
  if (urbanRural.value !== ALL_SCOPE) n++
  return n
})
</script>

<template>
  <div
    class="flex min-w-0 items-stretch rounded-full border bg-muted/40 shadow-sm"
    :class="compact ? 'w-auto' : 'flex-1'"
  >
    <SearchBarSegment
      v-model:open="locationOpen"
      :label="$t('searchBar.location.label')"
      :summary="locationSummary"
      :compact="compact"
      :has-value="locationHasValue"
      align="start"
    >
      <SearchLocationPopover
        v-model:search="search"
        :countries="countries"
        :selected-countries="selectedCountries"
        :available-regions="availableRegions"
        :selected-region-keys="selectedRegionKeys"
        :placeholder="$t('filters.searchPlaceholder')"
        @toggle-country="emit('toggle-country', $event)"
        @toggle-region="emit('toggle-region', $event)"
        @select-country="emit('select-country', $event)"
        @set-nearby="handleSetNearby"
        @pick-recent="emit('pick-recent', $event)"
      />
    </SearchBarSegment>

    <Separator orientation="vertical" class="h-auto" :class="compact ? 'my-1.5' : 'my-2'" />

    <SearchBarSegment
      v-model:open="propertiesOpen"
      :label="$t('searchBar.properties.label')"
      :summary="propertiesSummary > 0 ? $t('searchBar.activeCount', { count: propertiesSummary }) : $t('searchBar.properties.placeholder')"
      :compact="compact"
      :has-value="propertiesSummary > 0"
      align="start"
      content-class="w-2xl p-5"
    >
      <SearchPropertiesPopover
        v-model:price-min="priceMin"
        v-model:price-max="priceMax"
        v-model:land-area-min="landAreaMin"
        v-model:land-area-max="landAreaMax"
        v-model:living-area-min="livingAreaMin"
        v-model:living-area-max="livingAreaMax"
        v-model:year-built-min="yearBuiltMin"
        v-model:year-built-max="yearBuiltMax"
        v-model:renovation-year-min="renovationYearMin"
        v-model:renovation-year-max="renovationYearMax"
        v-model:category-filter="categoryFilter"
        v-model:platform-filter="platformFilter"
        v-model:condition-filter="conditionFilter"
        v-model:features-filter="featuresFilter"
        v-model:only-with-photos="onlyWithPhotos"
        v-model:include-cancelled="includeCancelled"
        v-model:hide-rules-only="hideRulesOnly"
        :categories="categories"
        :platforms="platformOptions"
        :currency="currency"
      />
    </SearchBarSegment>

    <Separator orientation="vertical" class="h-auto" :class="compact ? 'my-1.5' : 'my-2'" />

    <SearchBarSegment
      v-model:open="environmentOpen"
      :label="$t('searchBar.environment.label')"
      :summary="environmentSummary > 0 ? $t('searchBar.activeCount', { count: environmentSummary }) : $t('searchBar.environment.placeholder')"
      :compact="compact"
      :has-value="environmentSummary > 0"
      align="end"
    >
      <SearchEnvironmentPopover
        v-model:near-sea="nearSea"
        v-model:near-lake="nearLake"
        v-model:near-river="nearRiver"
        v-model:near-mountain="nearMountain"
        v-model:near-airport="nearAirport"
        v-model:near-ski-downhill="nearSkiDownhill"
        v-model:near-ski-nordic="nearSkiNordic"
        v-model:urban-rural="urbanRural"
      />
    </SearchBarSegment>
  </div>
</template>
