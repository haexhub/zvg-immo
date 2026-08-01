<script setup lang="ts">
import type { CountryEntry } from '~/server/crawlers/registry'
import type { SavedSearch } from '~/server/api/saved-searches/index.get'
import { AUCTION_SEARCH_STATE_KEY, useAuctionSearchState } from '~/composables/useAuctionSearchState'

// Owns the single useAuctionSearchState instance for /search — the header
// slot below (rendered here) and the page (injecting AUCTION_SEARCH_STATE_KEY)
// both need to read/write the same reactive filters, and a layout is the only
// common ancestor of "always-visible header" and "page content" that Nuxt's
// automatic layout wiring (app.vue's <NuxtLayout><NuxtPage/></NuxtLayout>)
// gives us — a page can't hand named slot content up to its own layout.
const route = useRoute()
const { user } = useAuth()
const { t } = useI18n()
const { eurToDisplay, displayToEur } = useCurrencyDisplay()

const { data: countries } = await useFetch<CountryEntry[]>('/api/regions', {
  cache: 'no-store',
  default: () => [],
})

// Admin-configured default for the hideRulesOnly filter (/settings'
// "Dashboard-Anzeige" — see server/utils/app-settings.ts's
// getHideRulesOnlyAuctions). Public endpoint since every visitor needs it.
const { data: displaySettings } = await useFetch<{ hideRulesOnlyAuctions: boolean }>('/api/display-settings', {
  default: () => ({ hideRulesOnlyAuctions: true }),
})
const hideRulesOnlyServerDefault = computed(() => displaySettings.value?.hideRulesOnlyAuctions ?? true)

const state = useAuctionSearchState({
  countries,
  hideRulesOnlyServerDefault,
  eurToDisplay,
  displayToEur,
})
provide(AUCTION_SEARCH_STATE_KEY, { ...state, countries })

const { search, sortBy, boundToMap, filtersOpen, selectedCountries, activeFilterCount, initializeMountedState } = state
onMounted(initializeMountedState)

// A country suggestion (see SearchLocationAutocomplete) is a real filter, not
// text — pick it, and the header search box just scopes to that country.
function selectHeaderCountry(code: string): void {
  selectedCountries.value = [code]
}

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
</script>

<template>
  <div class="h-screen overflow-hidden flex flex-col">
    <SiteHeader>
      <template #search>
        <SearchToolbar
          v-model:search="search"
          v-model:sort-by="sortBy"
          v-model:bound-to-map="boundToMap"
          :countries="countries ?? []"
          :logged-in="!!user"
          :saving-search="savingSearch"
          :active-filter-count="activeFilterCount"
          @save-search="saveCurrentSearch"
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
