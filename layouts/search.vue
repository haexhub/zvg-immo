<script setup lang="ts">
import type { CountryEntry } from '~/server/crawlers/registry'
import type { AuctionSearchResponse } from '~/server/api/auctions.get'
import { ArrowUpDown } from 'lucide-vue-next'
import { AUCTION_SEARCH_STATE_KEY, useAuctionSearchState } from '~/composables/useAuctionSearchState'
import { AUCTION_SEARCH_RESULT_KEY } from '~/composables/useAuctionSearchResult'

// Owns the single useAuctionSearchState instance for /search — the header
// slot below (rendered here) and the page (injecting AUCTION_SEARCH_STATE_KEY)
// both need to read/write the same reactive filters, and a layout is the only
// common ancestor of "always-visible header" and "page content" that Nuxt's
// automatic layout wiring (app.vue's <NuxtLayout><NuxtPage/></NuxtLayout>)
// gives us — a page can't hand named slot content up to its own layout.
const { eurToDisplay, displayToEur, currency } = useCurrencyDisplay()
const propertyTypeLabel = usePropertyTypeLabel()
const { locale } = useI18n()
// Set by SiteHeader once the results pane is scrolled — shrinks the bar and
// the sort button along with the header itself.
const compact = useHeaderCompact()

// Admin-configured default for the hideRulesOnly filter (/settings'
// "Dashboard-Anzeige" — see server/utils/app-settings.ts's
// getHideRulesOnlyAuctions). Public endpoint since every visitor needs it.
// Independent of /api/regions, so fetch both concurrently rather than
// serially awaiting one after the other.
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

const state = useAuctionSearchState({
  countries,
  hideRulesOnlyServerDefault,
  eurToDisplay,
  displayToEur,
})
provide(AUCTION_SEARCH_STATE_KEY, { ...state, countries })

// Search results are filtered and paginated in Postgres. Only compact card
// summaries reach the browser; detail text, documents and galleries stay on
// the per-auction endpoint. Lives here (not pages/search.vue) so the header's
// Properties popover can read the same facets (courts/categories) the list
// derives them from — see AUCTION_SEARCH_RESULT_KEY.
const { data, pending, error, refresh } = useLazyFetch<AuctionSearchResponse | null>('/api/auctions', {
  query: state.queryParams,
  default: () => null,
})
const courts = computed<string[]>(() => data.value?.facets.authorities ?? [])
const categories = computed<Array<{ id: string; label: string; count: number }>>(() => {
  return (data.value?.facets.categories ?? [])
    .map(({ id, count }) => ({ id, label: propertyTypeLabel(id), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, locale.value))
})
provide(AUCTION_SEARCH_RESULT_KEY, { data, pending, error, refresh, courts, categories })

const {
  search, selectedCountries, selectedRegionKeys, availableRegions, headerLabel,
  priceMin, priceMax, landAreaMin, landAreaMax, livingAreaMin, livingAreaMax,
  yearBuiltMin, yearBuiltMax, renovationYearMin, renovationYearMax,
  authorityFilter, categoryFilter, conditionFilter, featuresFilter,
  onlyWithPhotos, includeCancelled, hideRulesOnly,
  nearSea, nearLake, nearRiver, nearMountain, nearAirport, nearSkiDownhill, nearSkiNordic, urbanRural,
  nearLat, nearLng, nearRadius, sortBy,
  toggleCountry, toggleRegion, initializeMountedState,
} = state

function setNearby(lat: number, lng: number): void {
  nearLat.value = lat
  nearLng.value = lng
  nearRadius.value = 25
}

const router = useRouter()
function pickRecent(query: Record<string, string>): void {
  router.push({ path: '/search', query })
}

onMounted(() => {
  initializeMountedState()
})
</script>

<template>
  <div class="h-screen overflow-hidden flex flex-col">
    <SiteHeader>
      <template #search>
        <div
          class="mx-auto flex w-full items-center gap-2 transition-all duration-200"
          :class="compact ? 'max-w-full justify-center' : 'max-w-3xl'"
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
            :location-summary="headerLabel"
            :countries="countries ?? []"
            :selected-countries="selectedCountries"
            :available-regions="availableRegions"
            :selected-region-keys="selectedRegionKeys"
            :categories="categories"
            :currency="currency"
            @toggle-country="toggleCountry"
            @toggle-region="toggleRegion"
            @select-country="toggleCountry"
            @set-nearby="setNearby"
            @pick-recent="pickRecent"
          />
          <Select v-model="sortBy">
            <!-- SelectTrigger's own `data-[size=default]:h-9` outranks a plain
                 `h-14`, so the large state answers in the same variant. -->
            <SelectTrigger
              class="shrink-0 justify-center rounded-full p-0 transition-all duration-200 [&>svg]:hidden"
              :class="compact ? 'size-9' : 'w-14 data-[size=default]:h-14'"
              :title="$t('search.sortLabel')"
              :aria-label="$t('search.sortLabel')"
            >
              <span class="flex items-center justify-center">
                <ArrowUpDown class="size-4" />
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{{ $t('search.sortDefault') }}</SelectItem>
              <SelectItem value="dateAsc">{{ $t('search.sortDateAsc') }}</SelectItem>
              <SelectItem value="priceAsc">{{ $t('search.sortPriceAsc') }}</SelectItem>
              <SelectItem value="priceDesc">{{ $t('search.sortPriceDesc') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </template>
    </SiteHeader>
    <div class="flex-1 min-h-0">
      <slot />
    </div>
  </div>
</template>
