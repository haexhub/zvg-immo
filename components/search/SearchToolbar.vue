<script setup lang="ts">
import { ListFilter } from 'lucide-vue-next'
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
</script>

<template>
  <div class="shrink-0 mb-3 flex items-center justify-end gap-3">
    <div v-if="filteredCount" class="text-sm text-muted-foreground mr-auto">
      {{ $t('search.resultsCount', { count: filteredCount }) }}<span v-if="geoData">
        · {{ filteredGeoCount }} {{ $t('search.onMap') }} ({{ $t('search.geocoded', { done: geoData.geocodedCount, total: geoData.auctions.length }) }}<span v-if="geoData.unresolvableCount > 0">, {{ $t('search.unresolvable', { count: geoData.unresolvableCount }) }}</span><span v-if="geocodingInProgress">, {{ $t('search.geocodingRunning') }}</span>)
      </span>
    </div>
    <Button v-if="loggedIn" type="button" variant="outline" :disabled="savingSearch" @click="emit('save-search')">
      {{ savingSearch ? $t('search.savingSearch') : $t('search.saveSearch') }}
    </Button>
    <Button type="button" variant="outline" class="relative" @click="emit('open-filters')">
      <ListFilter class="h-4 w-4" />
      <span>{{ $t('search.filterButton') }}</span>
      <span
        v-if="activeFilterCount > 0"
        class="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground"
      >{{ activeFilterCount }}</span>
    </Button>
  </div>
</template>
