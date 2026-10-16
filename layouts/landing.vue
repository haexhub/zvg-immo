<script setup lang="ts">
import { Search } from 'lucide-vue-next'
import type { CountryEntry } from '~/server/crawlers/registry'
import { ALL_SCOPE } from '~/lib/auction-constants'
import { defaultAuctionSearchFilters, serializeAuctionSearchFilters } from '~/lib/auction-search-filter-contract'
import { toggleInArray } from '~/lib/toggle-array'

// The landing search bar lives in SiteHeader's search row, and a page can't
// hand named slot content up to its own layout — so, like layouts/search.vue,
// the layout owns the filter state the bar writes to. It used to sit in the
// hero and teleport itself into the header on scroll; the header now hosts it
// outright and only shrinks it (see useHeaderCompact).
// /api/display-settings carries the admin default for hideRulesOnly, which
// /search falls back to whenever llmOnly is absent from the URL — the landing
// checkbox has to start from (and serialize against) that same default.
const [{ data: countries }, { data: displaySettings }] = await Promise.all([
  useFetch<CountryEntry[]>('/api/regions', {
    cache: 'no-store',
    default: () => [],
  }),
  useFetch<{ hideRulesOnlyAuctions: boolean }>('/api/display-settings', {
    default: () => ({ hideRulesOnlyAuctions: true }),
  }),
])
const hideRulesOnlyServerDefault = computed(() => displaySettings.value?.hideRulesOnlyAuctions ?? true)

const { t } = useI18n()
const router = useRouter()
const countryLabel = useCountryLabel()
const { currency } = useCurrencyDisplay()
const compact = useHeaderCompact()

// The landing bar used to have no filter state of its own and just handed
// off to the search page (?openFilters=1) the moment its filter button was
// clicked — that's the bug report this bar replaces. It now owns the same
// shape of state as useAuctionSearchState (minus the URL sync and the
// list-view-only concerns like sort/view), and only navigates to
// /search once the user actually submits.
const search = ref('')
const selectedCountries = ref<string[]>([])
const selectedRegionKeys = ref<string[]>([])
const availableRegions = computed(() => {
  if (selectedCountries.value.length === 0) return []
  return (countries.value ?? [])
    .filter((c) => selectedCountries.value.includes(c.code))
    .flatMap((c) => c.regions.map((r) => ({ ...r, key: `${c.code}:${r.code}`, countryName: countryLabel(c.code, c.name) })))
})

const priceMin = ref<number | null>(null)
const priceMax = ref<number | null>(null)
const landAreaMin = ref<number | null>(null)
const landAreaMax = ref<number | null>(null)
const livingAreaMin = ref<number | null>(null)
const livingAreaMax = ref<number | null>(null)
const yearBuiltMin = ref<number | null>(null)
const yearBuiltMax = ref<number | null>(null)
const renovationYearMin = ref<number | null>(null)
const renovationYearMax = ref<number | null>(null)
const authorityFilter = ref(ALL_SCOPE)
const categoryFilter = ref(ALL_SCOPE)
const platformFilter = ref<string[]>([])
const conditionFilter = ref<string[]>([])
const featuresFilter = ref<string[]>([])
const onlyWithPhotos = ref(false)
const includeCancelled = ref(false)
const hideRulesOnly = ref(hideRulesOnlyServerDefault.value)

const nearSea = ref<number | null>(null)
const nearLake = ref<number | null>(null)
const nearRiver = ref<number | null>(null)
const nearMountain = ref<number | null>(null)
const nearAirport = ref<number | null>(null)
const nearSkiDownhill = ref<number | null>(null)
const nearSkiNordic = ref<number | null>(null)
const urbanRural = ref(ALL_SCOPE)
const nearLat = ref<number | null>(null)
const nearLng = ref<number | null>(null)
const nearRadius = ref<number | null>(null)

const selectedCountryLabel = computed(() => {
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
const locationSummary = computed(() => {
  if (selectedCountries.value.length) {
    return selectedRegionLabel.value ? `${selectedRegionLabel.value}, ${selectedCountryLabel.value}` : selectedCountryLabel.value
  }
  return search.value.trim() || t('searchBar.location.placeholder')
})

function toggleCountry(code: string): void {
  selectedCountries.value = toggleInArray(selectedCountries.value, code)
  platformFilter.value = []
}
function toggleRegion(key: string): void {
  selectedRegionKeys.value = toggleInArray(selectedRegionKeys.value, key)
  platformFilter.value = []
}
function setNearby(lat: number, lng: number): void {
  nearLat.value = lat
  nearLng.value = lng
  nearRadius.value = 25
}

// Serialized through the shared filter contract so /search parses exactly
// what the landing bar meant (UI region keys, explicit llmOnly=0, ...).
function submitSearch(): void {
  const query = serializeAuctionSearchFilters({
    ...defaultAuctionSearchFilters(),
    countries: selectedCountries.value,
    // Region keys of a since-deselected country stay in the ref; drop them.
    regionKeys: selectedRegionKeys.value.filter((key) => availableRegions.value.some((r) => r.key === key)),
    search: search.value,
    authority: authorityFilter.value,
    priceMin: priceMin.value, priceMax: priceMax.value,
    landMin: landAreaMin.value, landMax: landAreaMax.value,
    livMin: livingAreaMin.value, livMax: livingAreaMax.value,
    yearBuiltMin: yearBuiltMin.value, yearBuiltMax: yearBuiltMax.value,
    renovationYearMin: renovationYearMin.value, renovationYearMax: renovationYearMax.value,
    nearSea: nearSea.value, nearLake: nearLake.value, nearRiver: nearRiver.value,
    nearMountain: nearMountain.value, nearAirport: nearAirport.value,
    nearSkiDownhill: nearSkiDownhill.value, nearSkiNordic: nearSkiNordic.value,
    urbanRural: urbanRural.value,
    nearLat: nearLat.value, nearLng: nearLng.value, nearRadius: nearRadius.value,
    category: categoryFilter.value,
    platform: platformFilter.value, condition: conditionFilter.value, features: featuresFilter.value,
    onlyWithPhotos: onlyWithPhotos.value, includeCancelled: includeCancelled.value,
    hideRulesOnly: hideRulesOnly.value,
  }, hideRulesOnlyServerDefault.value)
  router.push({ path: '/search', query })
}

function pickRecent(query: Record<string, string>): void {
  router.push({ path: '/search', query })
}
</script>

<template>
  <div class="min-h-full flex flex-col">
    <SiteHeader>
      <template #search>
        <form
          class="mx-auto flex w-full items-center gap-2 transition-all duration-200"
          :class="compact ? 'max-w-full justify-center' : 'max-w-3xl'"
          @submit.prevent="submitSearch"
        >
          <SearchBar
            v-model:search="search"
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
            v-model:authority-filter="authorityFilter"
            v-model:category-filter="categoryFilter"
            v-model:platform-filter="platformFilter"
            v-model:condition-filter="conditionFilter"
            v-model:features-filter="featuresFilter"
            v-model:only-with-photos="onlyWithPhotos"
            v-model:include-cancelled="includeCancelled"
            v-model:hide-rules-only="hideRulesOnly"
            v-model:near-sea="nearSea"
            v-model:near-lake="nearLake"
            v-model:near-river="nearRiver"
            v-model:near-mountain="nearMountain"
            v-model:near-airport="nearAirport"
            v-model:near-ski-downhill="nearSkiDownhill"
            v-model:near-ski-nordic="nearSkiNordic"
            v-model:urban-rural="urbanRural"
            :location-summary="locationSummary"
            :countries="countries ?? []"
            :selected-countries="selectedCountries"
            :available-regions="availableRegions"
            :selected-region-keys="selectedRegionKeys"
            :categories="[]"
            :currency="currency"
            @toggle-country="toggleCountry"
            @toggle-region="toggleRegion"
            @select-country="toggleCountry"
            @set-nearby="setNearby"
            @pick-recent="pickRecent"
          />
          <Button
            type="submit"
            class="shrink-0 rounded-full p-0 transition-all duration-200"
            :class="compact ? 'h-9 w-9' : 'h-14 w-14'"
          >
            <Search class="h-4 w-4" />
            <span class="sr-only">{{ $t('landing.hero.searchCta') }}</span>
          </Button>
        </form>
      </template>
    </SiteHeader>
    <div class="flex-1">
      <slot />
    </div>
  </div>
</template>
