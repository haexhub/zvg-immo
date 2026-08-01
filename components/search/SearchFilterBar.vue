<script setup lang="ts">
// The one search+filter bar used on both the landing hero and the search
// page's header — same component, same look (the landing page's rounded
// pill), so "unifying search and filters" means one file, not two visually
// different implementations kept in sync by hand.
import { ListFilter } from 'lucide-vue-next'
import type { CountryEntry } from '~/server/crawlers/registry'

withDefaults(defineProps<{
  placeholder?: string
  countries?: CountryEntry[]
  activeFilterCount?: number
}>(), {
  countries: () => [],
  activeFilterCount: 0,
})

const emit = defineEmits<{
  (e: 'select-country', code: string): void
  (e: 'open-filters'): void
}>()

const search = defineModel<string>('search', { required: true })
</script>

<template>
  <div class="flex min-w-0 flex-1 items-center gap-2">
    <div class="relative min-w-0 flex-1">
      <SearchLocationAutocomplete
        v-model="search"
        type="search"
        :placeholder="placeholder"
        input-class="h-12 w-full rounded-full bg-background text-base shadow-sm"
        :countries="countries"
        @select-country="emit('select-country', $event)"
      />
    </div>

    <Button
      type="button"
      variant="outline"
      size="icon"
      class="relative h-12 w-12 shrink-0 rounded-full shadow-sm"
      :aria-label="$t('search.filterButton')"
      @click="emit('open-filters')"
    >
      <ListFilter class="h-5 w-5" />
      <span
        v-if="activeFilterCount > 0"
        class="absolute -top-1 -right-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-medium text-primary-foreground"
      >{{ activeFilterCount }}</span>
    </Button>
  </div>
</template>
