<script setup lang="ts">
import { ListFilter, Search } from 'lucide-vue-next'
import type { GeoCrawlResult } from '~/server/api/auctions-geo.get'

defineProps<{
  filteredCount: number
  geoData: GeoCrawlResult | null
  filteredGeoCount: number
  geocodingInProgress: boolean
  loggedIn: boolean
  savingSearch: boolean
  activeFilterCount: number
}>()

const emit = defineEmits<{
  (e: 'save-search'): void
  (e: 'open-filters'): void
}>()

// Free-text search — the prominent primary control. Also drives the map
// viewport (see search.vue geoFitKey), so a place/region/country term both
// filters the list and recentres the map.
const search = defineModel<string>('search', { required: true })
const sortBy = defineModel<string>('sortBy', { required: true })
// "Kartenbereich": restrict the result list to the map's visible viewport.
const boundToMap = defineModel<boolean>('boundToMap', { required: true })
</script>

<template>
  <div class="shrink-0 mb-3 space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <div class="relative flex-1 min-w-48 max-w-md">
        <SearchLocationAutocomplete
          v-model="search"
          type="search"
          :placeholder="$t('filters.searchPlaceholder')"
          input-class="pl-9"
        >
          <template #icon>
            <Search class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          </template>
        </SearchLocationAutocomplete>
      </div>

      <Button type="button" variant="outline" class="relative" @click="emit('open-filters')">
        <ListFilter class="h-4 w-4" />
        <span>{{ $t('search.filterButton') }}</span>
        <span
          v-if="activeFilterCount > 0"
          class="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground"
        >{{ activeFilterCount }}</span>
      </Button>

      <Select v-model="sortBy">
        <SelectTrigger class="w-44">
          <SelectValue :placeholder="$t('search.sortLabel')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">{{ $t('search.sortDefault') }}</SelectItem>
          <SelectItem value="dateAsc">{{ $t('search.sortDateAsc') }}</SelectItem>
          <SelectItem value="priceAsc">{{ $t('search.sortPriceAsc') }}</SelectItem>
          <SelectItem value="priceDesc">{{ $t('search.sortPriceDesc') }}</SelectItem>
        </SelectContent>
      </Select>

      <label
        class="flex cursor-pointer select-none items-center gap-2 whitespace-nowrap text-sm"
        :title="$t('search.boundToMapHint')"
      >
        <Checkbox v-model="boundToMap" />
        {{ $t('search.boundToMap') }}
      </label>

      <Button v-if="loggedIn" type="button" variant="outline" class="ml-auto" :disabled="savingSearch" @click="emit('save-search')">
        {{ savingSearch ? $t('search.savingSearch') : $t('search.saveSearch') }}
      </Button>
    </div>

    <div v-if="filteredCount" class="text-sm text-muted-foreground">
      {{ $t('search.resultsCount', { count: filteredCount }) }}<span v-if="geoData">
        · {{ filteredGeoCount }} {{ $t('search.onMap') }} ({{ $t('search.geocoded', { done: geoData.geocodedCount, total: geoData.total }) }}<span v-if="geoData.unresolvableCount > 0">, {{ $t('search.unresolvable', { count: geoData.unresolvableCount }) }}</span><span v-if="geocodingInProgress">, {{ $t('search.geocodingRunning') }}</span>)
      </span>
    </div>
  </div>
</template>
