<script setup lang="ts">
// Type-ahead place suggestions (Ort — Region [Land], like zvgscout.com) over
// the curated lib/de-places.ts gazetteer. Wraps a plain Input so it's a
// drop-in replacement wherever the free-text search box lives (landing hero,
// search-page toolbar) — selecting a suggestion just writes its name into the
// v-model, which both call sites already feed into the existing substring
// search (lib/auction-filters.ts's filterAuctions), so no new filter
// dimension is introduced.
import { filterPlaces } from '~/lib/de-places'

withDefaults(defineProps<{ placeholder?: string; inputClass?: string; type?: string }>(), {
  type: 'text',
})
const model = defineModel<string>({ required: true })

const open = ref(false)
const activeIndex = ref(-1)

const suggestions = computed(() => filterPlaces(model.value))

function pick(name: string) {
  model.value = name
  open.value = false
  activeIndex.value = -1
}

function onKeydown(e: KeyboardEvent) {
  if (!open.value || suggestions.value.length === 0) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % suggestions.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + suggestions.value.length) % suggestions.value.length
  } else if (e.key === 'Enter' && activeIndex.value >= 0) {
    e.preventDefault()
    pick(suggestions.value[activeIndex.value]!.name)
  } else if (e.key === 'Escape') {
    open.value = false
  }
}

function onBlur() {
  // Delay so a mousedown on a suggestion (see @mousedown.prevent below,
  // which itself only stops the input from losing focus visually) still
  // fires its click before the dropdown closes.
  setTimeout(() => {
    open.value = false
  }, 150)
}
</script>

<template>
  <slot name="icon" />
  <Input
    v-model="model"
    :type="type"
    :placeholder="placeholder"
    :class="inputClass"
    autocomplete="off"
    @focus="open = true"
    @input="open = true; activeIndex = -1"
    @keydown="onKeydown"
    @blur="onBlur"
  />
  <ul
    v-if="open && suggestions.length > 0"
    class="absolute inset-x-0 top-full z-50 mt-1 max-h-72 overflow-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
  >
    <li
      v-for="(s, i) in suggestions"
      :key="`${s.name}-${s.region}`"
      class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm"
      :class="i === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'"
      @mousedown.prevent="pick(s.name)"
    >
      <span>
        <span class="font-medium">{{ s.name }}</span>
        <span class="text-muted-foreground"> — {{ s.region }}</span>
      </span>
      <span class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {{ $t('country.de') }}
      </span>
    </li>
  </ul>
</template>
