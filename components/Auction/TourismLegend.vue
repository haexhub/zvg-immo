<script setup lang="ts">
import type { TourismCategory, TourismGridCategoryDef } from '~/lib/tourism-grid-categories'

// Single-select on purpose, not a checkbox-per-category toggle: the
// palette's colorblind-safety validation (see lib/tourism-grid-categories.ts)
// only passes for this hue set when at most one is ever rendered on the
// map at once, and overlapping semi-transparent choropleth fills of
// different hues also just blend into visual mud — so picking a category
// here replaces whichever was showing, it never adds to it.
const category = defineModel<TourismCategory | null>('category', { required: true })
// Owned by Map.client.vue so it can keep this panel and the visitor-density
// legend's panel mutually exclusive — both are wide enough to overlap (or
// get clipped by the map's overflow-hidden root) if both were open at once.
const open = defineModel<boolean>('open', { default: false })

defineProps<{
  categories: TourismGridCategoryDef[]
}>()

const { t } = useI18n()

function select(next: TourismCategory): void {
  category.value = category.value === next ? null : next
}
</script>

<template>
  <div class="flex flex-col items-start gap-1">
    <button
      type="button"
      class="cursor-pointer rounded-md border border-slate-900/15 bg-white/95 px-2.5 py-1 text-xs font-semibold text-gray-900 shadow-sm"
      :aria-expanded="open"
      aria-controls="tourism-legend-panel"
      @click="open = !open"
    >
      {{ t('map.tourismLayerToggle') }}<template v-if="category">: {{ t(`map.tourismCategory.${category}`) }}</template>
    </button>
    <div
      v-if="open"
      id="tourism-legend-panel"
      class="w-52 rounded-md border border-slate-900/15 bg-white/95 px-2 py-1.5 text-xs leading-tight text-gray-900 shadow-sm backdrop-blur-sm"
    >
      <button
        v-for="def in categories"
        :key="def.category"
        type="button"
        class="flex w-full cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-slate-900/10"
        :class="{ 'bg-slate-900/10 font-semibold': category === def.category }"
        @click="select(def.category)"
      >
        <span class="h-3 w-3 shrink-0 rounded-full" :style="{ backgroundColor: def.color }" />
        {{ t(`map.tourismCategory.${def.category}`) }}
      </button>
      <button
        type="button"
        class="mt-1 w-full cursor-pointer rounded border-t border-slate-900/10 px-1 pt-1.5 text-left text-gray-500 hover:bg-slate-900/10"
        @click="category = null"
      >
        {{ t('map.tourismLayerOff') }}
      </button>
    </div>
  </div>
</template>
