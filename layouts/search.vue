<script setup lang="ts">
import type { CountryEntry } from '~/server/crawlers/registry'
import { AUCTION_SEARCH_STATE_KEY, useAuctionSearchState } from '~/composables/useAuctionSearchState'

// Owns the single useAuctionSearchState instance for /search — the header
// slot below (rendered here) and the page (injecting AUCTION_SEARCH_STATE_KEY)
// both need to read/write the same reactive filters, and a layout is the only
// common ancestor of "always-visible header" and "page content" that Nuxt's
// automatic layout wiring (app.vue's <NuxtLayout><NuxtPage/></NuxtLayout>)
// gives us — a page can't hand named slot content up to its own layout.
const route = useRoute()
const router = useRouter()
const { eurToDisplay, displayToEur } = useCurrencyDisplay()

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

const { search, filtersOpen, selectedCountries, activeFilterCount, initializeMountedState } = state

// A country suggestion (see SearchLocationAutocomplete) is a real filter, not
// text — pick it, and the header search box just scopes to that country.
function selectHeaderCountry(code: string): void {
  selectedCountries.value = [code]
}

onMounted(() => {
  initializeMountedState()
  // The landing page's own filter button has nowhere to open a filter panel
  // (it has no filter state of its own) — it navigates here with this flag
  // instead, see pages/index.vue.
  if (route.query.openFilters === '1') {
    filtersOpen.value = true
    const query = { ...route.query }
    delete query.openFilters
    router.replace({ query })
  }
})
</script>

<template>
  <div class="h-screen overflow-hidden flex flex-col">
    <SiteHeader>
      <template #search>
        <SearchFilterBar
          v-model:search="search"
          :countries="countries ?? []"
          :active-filter-count="activeFilterCount"
          :placeholder="$t('filters.searchPlaceholder')"
          @open-filters="filtersOpen = true"
          @select-country="selectHeaderCountry"
        />
      </template>
    </SiteHeader>
    <div class="flex-1 min-h-0">
      <slot />
    </div>
  </div>
</template>
