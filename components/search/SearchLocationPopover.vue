<script setup lang="ts">
// Location tab of the Airbnb-style search bar (see SearchBar.vue). Free text +
// country picks reuse the existing SearchLocationAutocomplete unchanged;
// everything else (recent searches, nearby, country/region checkboxes) is
// new, laid out below the input inside the same popover.
import { Clock, MapPin } from 'lucide-vue-next'
import type { CountryEntry } from '~/server/crawlers/registry'
import { useRecentSearches } from '~/composables/useRecentSearches'

const { t } = useI18n()

const props = defineProps<{
  placeholder?: string
  countries: CountryEntry[]
  selectedCountries: string[]
  availableRegions: Array<{ key: string; name: string; countryName: string }>
  selectedRegionKeys: string[]
}>()

const emit = defineEmits<{
  (e: 'toggle-country', code: string): void
  (e: 'toggle-region', key: string): void
  (e: 'select-country', code: string): void
  (e: 'set-nearby', lat: number, lng: number): void
  (e: 'pick-recent', query: Record<string, string>): void
}>()

const search = defineModel<string>('search', { required: true })

const countryLabel = useCountryLabel()
const { entries: recentSearches, add: addRecentSearch } = useRecentSearches()

// Mirrors server/api/landing/rails.get.ts's COUNTRY_RAIL_CODES — the same
// countries already known to have good coverage, shown as a starting point
// before the user has typed or picked anything.
const SUGGESTED_COUNTRY_CODES = ['se', 'de', 'bg']
const showSuggestions = computed(() => !search.value.trim() && props.selectedCountries.length === 0)
const suggestedCountries = computed(() => {
  if (!showSuggestions.value) return []
  return SUGGESTED_COUNTRY_CODES
    .map((code) => props.countries.find((c) => c.code === code))
    .filter((c): c is CountryEntry => c != null)
})

const geoError = ref<string | null>(null)
const geoPending = ref(false)
function useNearby(): void {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    geoError.value = t('searchBar.location.geolocationUnsupported')
    return
  }
  geoPending.value = true
  geoError.value = null
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      geoPending.value = false
      emit('set-nearby', pos.coords.latitude, pos.coords.longitude)
      addRecentSearch(t('searchBar.location.nearby'), {})
    },
    () => {
      geoPending.value = false
      geoError.value = t('searchBar.location.geolocationFailed')
    },
    { timeout: 10_000 },
  )
}

function pickCountry(code: string): void {
  emit('select-country', code)
  addRecentSearch(countryLabel(code), { country: code })
}

function pickRecent(entry: { label: string; query: Record<string, string> }): void {
  emit('pick-recent', entry.query)
}
</script>

<template>
  <div class="space-y-5">
    <div class="relative">
      <SearchLocationAutocomplete
        v-model="search"
        type="search"
        :placeholder="placeholder"
        input-class="h-11 w-full rounded-lg border bg-background px-3 text-sm"
        :countries="countries"
        @select-country="pickCountry"
      />
    </div>

    <div v-if="recentSearches.length" class="space-y-1">
      <p class="px-1 text-xs font-medium text-muted-foreground">{{ $t('searchBar.location.recent') }}</p>
      <button
        v-for="(entry, i) in recentSearches"
        :key="i"
        type="button"
        class="flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left text-sm hover:bg-muted"
        @click="pickRecent(entry)"
      >
        <Clock class="h-4 w-4 shrink-0 text-muted-foreground" />
        {{ entry.label }}
      </button>
    </div>

    <div class="space-y-1">
      <p class="px-1 text-xs font-medium text-muted-foreground">{{ $t('searchBar.location.suggested') }}</p>
      <button
        type="button"
        class="flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left text-sm hover:bg-muted disabled:cursor-wait disabled:opacity-60"
        :disabled="geoPending"
        @click="useNearby"
      >
        <MapPin class="h-4 w-4 shrink-0 text-muted-foreground" />
        {{ geoPending ? $t('searchBar.location.nearbyPending') : $t('searchBar.location.nearby') }}
      </button>
      <p v-if="geoError" class="px-2 text-xs text-destructive">{{ geoError }}</p>
      <button
        v-for="c in suggestedCountries"
        :key="c.code"
        type="button"
        class="flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left text-sm hover:bg-muted"
        @click="pickCountry(c.code)"
      >
        <MapPin class="h-4 w-4 shrink-0 text-muted-foreground" />
        {{ countryLabel(c.code, c.name) }}
      </button>
    </div>

    <div class="space-y-2 border-t pt-4">
      <p class="px-1 text-xs font-medium text-muted-foreground">{{ $t('filters.country') }}</p>
      <div class="max-h-40 overflow-y-auto rounded-md border divide-y">
        <label
          v-for="c in countries"
          :key="c.code"
          class="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/50"
        >
          <Checkbox
            :model-value="selectedCountries.includes(c.code)"
            @update:model-value="emit('toggle-country', c.code)"
          />
          {{ countryLabel(c.code, c.name) }}
        </label>
      </div>
    </div>

    <div v-if="availableRegions.length" class="space-y-2">
      <p class="px-1 text-xs font-medium text-muted-foreground">{{ $t('filters.region') }}</p>
      <div class="max-h-40 overflow-y-auto rounded-md border divide-y">
        <label
          v-for="r in availableRegions"
          :key="r.key"
          class="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/50"
        >
          <Checkbox
            :model-value="selectedRegionKeys.includes(r.key)"
            @update:model-value="emit('toggle-region', r.key)"
          />
          {{ r.name }}<span v-if="selectedCountries.length > 1" class="text-muted-foreground"> ({{ r.countryName }})</span>
        </label>
      </div>
    </div>
  </div>
</template>
