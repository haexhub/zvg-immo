<script setup lang="ts">
// Airbnb-style search bar: Location / Properties / Environment. On desktop
// each is its own popover, side by side. Below the `md` breakpoint a
// three-way split has no room for its per-segment summary text, so this
// collapses into a single bar that opens one fullscreen Sheet with a tab per
// segment — replaces the old SearchFilterBar (free-text + a button that just
// forwarded to the Sheet sidebar). Used on both the landing hero
// (pages/index.vue) and the search page header (layouts/search.vue), each
// wiring it to its own filter state (a real useAuctionSearchState instance
// on the search page, a lighter local one on the landing page).
import { useMediaQuery } from '@vueuse/core'
import { Search } from 'lucide-vue-next'
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
const conditionFilter = defineModel<string>('conditionFilter', { required: true })
const featuresFilter = defineModel<string[]>('featuresFilter', { required: true })
const onlyWithPhotos = defineModel<boolean>('onlyWithPhotos', { required: true })
const includeCancelled = defineModel<boolean>('includeCancelled', { required: true })
const hideRulesOnly = defineModel<boolean>('hideRulesOnly', { required: true })

const nearSea = defineModel<number | null>('nearSea', { required: true })
const nearLake = defineModel<number | null>('nearLake', { required: true })
const nearRiver = defineModel<number | null>('nearRiver', { required: true })
const nearMountain = defineModel<number | null>('nearMountain', { required: true })
const nearAirport = defineModel<number | null>('nearAirport', { required: true })
const urbanRural = defineModel<string>('urbanRural', { required: true })

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

const propertiesSummary = computed(() => {
  let n = 0
  if (authorityFilter.value !== ALL_SCOPE) n++
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
  if (conditionFilter.value !== ALL_SCOPE) n++
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
  if (urbanRural.value !== ALL_SCOPE) n++
  return n
})

const { t } = useI18n()
const propertiesSummaryText = computed(() =>
  propertiesSummary.value > 0
    ? t('searchBar.activeCount', { count: propertiesSummary.value })
    : t('searchBar.properties.placeholder'),
)
const environmentSummaryText = computed(() =>
  environmentSummary.value > 0
    ? t('searchBar.activeCount', { count: environmentSummary.value })
    : t('searchBar.environment.placeholder'),
)

// Below `md`, the three segments collapse into one bar that opens a single
// Sheet with a tab per segment instead of three independently-triggered ones.
const isDesktop = useMediaQuery('(min-width: 768px)', { ssrWidth: 1280 })
const mobileSheetOpen = ref(false)
const activeMobileTab = ref<'location' | 'properties' | 'environment'>('location')
const mobileSummary = computed(() =>
  [props.locationSummary, propertiesSummaryText.value, environmentSummaryText.value].join(' · '),
)
</script>

<template>
  <div v-if="isDesktop" class="flex min-w-0 flex-1 items-stretch rounded-full border bg-muted/40 shadow-sm">
    <SearchBarSegment
      v-model:open="locationOpen"
      :label="$t('searchBar.location.label')"
      :summary="locationSummary"
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

    <Separator orientation="vertical" class="my-2 h-auto" />

    <SearchBarSegment
      v-model:open="propertiesOpen"
      :label="$t('searchBar.properties.label')"
      :summary="propertiesSummaryText"
      align="start"
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
        v-model:authority-filter="authorityFilter"
        v-model:category-filter="categoryFilter"
        v-model:condition-filter="conditionFilter"
        v-model:features-filter="featuresFilter"
        v-model:only-with-photos="onlyWithPhotos"
        v-model:include-cancelled="includeCancelled"
        v-model:hide-rules-only="hideRulesOnly"
        v-model:open="propertiesOpen"
        :categories="categories"
        :currency="currency"
      />
    </SearchBarSegment>

    <Separator orientation="vertical" class="my-2 h-auto" />

    <SearchBarSegment
      v-model:open="environmentOpen"
      :label="$t('searchBar.environment.label')"
      :summary="environmentSummaryText"
      align="end"
    >
      <SearchEnvironmentPopover
        v-model:near-sea="nearSea"
        v-model:near-lake="nearLake"
        v-model:near-river="nearRiver"
        v-model:near-mountain="nearMountain"
        v-model:near-airport="nearAirport"
        v-model:urban-rural="urbanRural"
        v-model:open="environmentOpen"
      />
    </SearchBarSegment>
  </div>

  <div v-else class="flex min-w-0 flex-1 items-stretch">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2 rounded-full border bg-muted/40 px-4 py-2 text-left shadow-sm"
      @click="mobileSheetOpen = true"
    >
      <Search class="size-4 shrink-0 text-muted-foreground" />
      <span class="block truncate text-sm font-medium">{{ mobileSummary }}</span>
    </button>

    <Sheet v-model:open="mobileSheetOpen">
      <SheetContent side="bottom" class="flex h-dvh max-h-dvh w-full flex-col gap-0 rounded-none border-t-0 p-0">
        <SheetHeader class="border-b">
          <SheetTitle>{{ $t('filters.title') }}</SheetTitle>
        </SheetHeader>
        <Tabs v-model="activeMobileTab" class="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList class="mx-4 mt-3 shrink-0 self-stretch">
            <TabsTrigger value="location" class="flex-1">{{ $t('searchBar.location.label') }}</TabsTrigger>
            <TabsTrigger value="properties" class="flex-1">{{ $t('searchBar.properties.label') }}</TabsTrigger>
            <TabsTrigger value="environment" class="flex-1">{{ $t('searchBar.environment.label') }}</TabsTrigger>
          </TabsList>

          <TabsContent value="location" class="min-h-0 flex-1 overflow-y-auto p-5">
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
          </TabsContent>

          <TabsContent value="properties" class="min-h-0 flex-1 overflow-y-auto p-5">
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
              v-model:authority-filter="authorityFilter"
              v-model:category-filter="categoryFilter"
              v-model:condition-filter="conditionFilter"
              v-model:features-filter="featuresFilter"
              v-model:only-with-photos="onlyWithPhotos"
              v-model:include-cancelled="includeCancelled"
              v-model:hide-rules-only="hideRulesOnly"
              v-model:open="mobileSheetOpen"
              :categories="categories"
              :currency="currency"
            />
          </TabsContent>

          <TabsContent value="environment" class="min-h-0 flex-1 overflow-y-auto p-5">
            <SearchEnvironmentPopover
              v-model:near-sea="nearSea"
              v-model:near-lake="nearLake"
              v-model:near-river="nearRiver"
              v-model:near-mountain="nearMountain"
              v-model:near-airport="nearAirport"
              v-model:urban-rural="urbanRural"
              v-model:open="mobileSheetOpen"
            />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  </div>
</template>
