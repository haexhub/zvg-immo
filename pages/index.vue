<script setup lang="ts">
import { useIntersectionObserver } from '@vueuse/core'
import { Search } from 'lucide-vue-next'
import type { LandingRailsResponse } from '~/server/api/landing/rails.get'
import type { CountryEntry } from '~/server/crawlers/registry'
import { ALL_SCOPE, isAllScope } from '~/lib/auction-constants'
import { toggleInArray } from '~/lib/toggle-array'

// Independent endpoints — fetch concurrently rather than serially awaiting
// one after the other.
const [{ data: rails }, { data: countries }] = await Promise.all([
  useFetch<LandingRailsResponse | null>('/api/landing/rails', {
    cache: 'no-store',
    default: () => null,
  }),
  useFetch<CountryEntry[]>('/api/regions', {
    cache: 'no-store',
    default: () => [],
  }),
])

const geoRails = computed(() => {
  if (!rails.value) return []
  return (['sea', 'mountains', 'lakes', 'rivers'] as const)
    .map((key) => ({ key, items: rails.value![key] }))
    .filter((geo) => geo.items.length > 0)
})

const { t } = useI18n()
const router = useRouter()
const countryLabel = useCountryLabel()
const { currency } = useCurrencyDisplay()

// The landing bar used to have no filter state of its own and just handed
// off to the search page (?openFilters=1) the moment its filter button was
// clicked — that's the bug report this bar replaces. It now owns the same
// shape of local state as useAuctionSearchState (minus the URL sync and the
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
const conditionFilter = ref(ALL_SCOPE)
const featuresFilter = ref<string[]>([])
const onlyWithPhotos = ref(false)
const includeCancelled = ref(false)
const hideRulesOnly = ref(false)

const nearSea = ref<number | null>(null)
const nearLake = ref<number | null>(null)
const nearRiver = ref<number | null>(null)
const nearMountain = ref<number | null>(null)
const nearAirport = ref<number | null>(null)
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

// Airbnb-style collapsing header: once the hero search bar scrolls out from
// under the sticky SiteHeader, a narrow summary pill takes its place so the
// search stays reachable while browsing the rails below.
const heroSearchRef = ref<HTMLElement>()
const heroSearchVisible = ref(true)
useIntersectionObserver(
  heroSearchRef,
  ([entry]) => { heroSearchVisible.value = entry?.isIntersecting ?? true },
  { rootMargin: '-64px 0px 0px 0px' },
)
const showCompactSearch = computed(() => !heroSearchVisible.value)

function scrollToHeroSearch(): void {
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function toggleCountry(code: string): void {
  selectedCountries.value = toggleInArray(selectedCountries.value, code)
}
function toggleRegion(key: string): void {
  selectedRegionKeys.value = toggleInArray(selectedRegionKeys.value, key)
}
function setNearby(lat: number, lng: number): void {
  nearLat.value = lat
  nearLng.value = lng
  nearRadius.value = 25
}

function submitSearch(): void {
  const query: Record<string, string> = {}
  if (selectedCountries.value.length) query.country = selectedCountries.value.join(',')
  if (selectedRegionKeys.value.length) {
    const regionNames = selectedRegionKeys.value
      .map((key) => availableRegions.value.find((r) => r.key === key))
      .filter((r): r is NonNullable<typeof r> => r != null)
      .map((r) => `${r.country}:${r.name}`)
    if (regionNames.length) query.regionNames = regionNames.join(',')
  }
  const q = search.value.trim()
  if (q) query.q = q
  if (!isAllScope(authorityFilter.value)) query.authority = authorityFilter.value
  if (priceMin.value != null) query.priceMin = String(priceMin.value)
  if (priceMax.value != null) query.priceMax = String(priceMax.value)
  if (landAreaMin.value != null) query.landMin = String(landAreaMin.value)
  if (landAreaMax.value != null) query.landMax = String(landAreaMax.value)
  if (livingAreaMin.value != null) query.livMin = String(livingAreaMin.value)
  if (livingAreaMax.value != null) query.livMax = String(livingAreaMax.value)
  if (yearBuiltMin.value != null) query.yearBuiltMin = String(yearBuiltMin.value)
  if (yearBuiltMax.value != null) query.yearBuiltMax = String(yearBuiltMax.value)
  if (renovationYearMin.value != null) query.renovationYearMin = String(renovationYearMin.value)
  if (renovationYearMax.value != null) query.renovationYearMax = String(renovationYearMax.value)
  if (nearSea.value != null) query.nearSea = String(nearSea.value)
  if (nearLake.value != null) query.nearLake = String(nearLake.value)
  if (nearRiver.value != null) query.nearRiver = String(nearRiver.value)
  if (nearMountain.value != null) query.nearMountain = String(nearMountain.value)
  if (nearAirport.value != null) query.nearAirport = String(nearAirport.value)
  if (!isAllScope(urbanRural.value)) query.urbanRural = urbanRural.value
  if (nearLat.value != null && nearLng.value != null) {
    query.nearLat = String(nearLat.value)
    query.nearLng = String(nearLng.value)
    query.nearRadius = String(nearRadius.value ?? 25)
  }
  if (!isAllScope(categoryFilter.value)) query.category = categoryFilter.value
  if (!isAllScope(conditionFilter.value)) query.condition = conditionFilter.value
  if (featuresFilter.value.length) query.features = featuresFilter.value.join(',')
  if (onlyWithPhotos.value) query.photos = '1'
  if (includeCancelled.value) query.cancelled = '1'
  if (hideRulesOnly.value) query.llmOnly = '1'
  router.push({ path: '/search', query })
}

function pickRecent(query: Record<string, string>): void {
  router.push({ path: '/search', query })
}
</script>

<template>
  <main>
    <!-- Search -->
    <section class="border-b px-6 py-10 sm:py-14">
      <div class="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 text-center">
        <h1 class="text-3xl font-bold tracking-tight sm:text-4xl">{{ $t('landing.hero.headline') }}</h1>
        <p class="max-w-xl text-muted-foreground">{{ $t('landing.hero.subheadline') }}</p>
        <form ref="heroSearchRef" class="flex w-full max-w-2xl items-center gap-2" @submit.prevent="submitSearch">
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
          <Button type="submit" size="lg" class="h-12 w-12 shrink-0 rounded-full p-0">
            <Search class="h-4 w-4" />
            <span class="sr-only">{{ $t('landing.hero.searchCta') }}</span>
          </Button>
        </form>
        <ul class="flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
          <li v-for="(item, i) in $tm('landing.hero.trust')" :key="i">{{ $rt(item) }}</li>
        </ul>
      </div>
    </section>

    <!-- Collapsed search, shown once the hero bar scrolls under the header -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0 -translate-y-1"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-1"
    >
      <div v-if="showCompactSearch" class="sticky top-16 z-30 border-b bg-background/95 px-4 py-2 backdrop-blur supports-backdrop-filter:bg-background/60">
        <button
          type="button"
          class="mx-auto flex w-full max-w-sm items-center justify-between gap-3 rounded-full border bg-background px-4 py-2 shadow-sm transition-shadow hover:shadow-md"
          :aria-label="$t('landing.hero.expandSearch')"
          @click="scrollToHeroSearch"
        >
          <span class="truncate text-sm font-medium">{{ locationSummary }}</span>
          <Search class="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </div>
    </Transition>

    <!-- Category rails -->
    <div class="w-full px-3">
      <LandingCategoryRail v-for="rail in rails?.countryRails" :key="rail.code" :title="$t('landing.rails.country.title', { name: rail.name })">
        <div v-for="a in rail.auctions" :key="`${a.platform}:${a.externalId}`" class="w-72 shrink-0 snap-start">
          <AuctionCard :auction="a" class="h-full" />
        </div>
      </LandingCategoryRail>

      <LandingCategoryRail
        v-if="rails?.bestCondition.length"
        :title="$t('landing.rails.bestCondition.title')"
        :subtitle="$t('landing.rails.bestCondition.subtitle')"
      >
        <div v-for="a in rails.bestCondition" :key="`${a.platform}:${a.externalId}`" class="w-72 shrink-0 snap-start">
          <AuctionCard :auction="a" class="h-full" />
        </div>
      </LandingCategoryRail>

      <LandingCategoryRail
        v-for="geo in geoRails"
        :key="geo.key"
        :title="$t(`landing.rails.${geo.key}.title`)"
        :subtitle="$t(`landing.rails.${geo.key}.subtitle`)"
      >
        <div v-for="a in geo.items" :key="`${a.platform}:${a.externalId}`" class="w-72 shrink-0 snap-start">
          <AuctionCard :auction="a" class="h-full" />
        </div>
      </LandingCategoryRail>
    </div>

    <!-- Footer -->
    <footer class="mt-6 flex flex-col items-center justify-between gap-4 border-t px-6 py-8 text-sm text-muted-foreground sm:flex-row">
      <span class="flex items-center gap-2 font-semibold text-foreground">
        <SitePropHammerLogo class="h-6 w-6 text-amber-500" />
        {{ $t('nav.brand') }}
      </span>
      <span>{{ $t('landing.footer.tagline') }}</span>
      <span>{{ $t('landing.footer.legal') }}</span>
    </footer>
  </main>
</template>
