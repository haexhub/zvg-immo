<script setup lang="ts">
// Type-ahead suggestions (Ort — Region [Land], like zvgscout.com) over the
// curated lib/de-places.ts gazetteer, plus the enabled countries themselves
// (server/crawlers/registry.ts's CountryEntry list, e.g. "Deutschland"). Wraps
// a plain Input so it's a drop-in replacement wherever the free-text search
// box lives (landing hero, search-page toolbar).
//
// A place suggestion writes its name into the v-model, which both call sites
// feed into the substring text search — that's the right behaviour for a
// city/region name. A country is different: an auction's address/title text
// almost never contains its own country's name, so treating "Deutschland" as
// a text search would silently match ~nothing. Selecting a country instead
// emits select-country so the caller can apply it as an actual country
// filter (search.vue: selectedCountries; landing hero: navigate with
// ?country=) and clears the text field, since the pick already fully
// expresses the intent.
import { filterPlaces, placeSearchTerm } from '~/lib/de-places'
import type { CountryEntry } from '~/server/crawlers/registry'

const props = withDefaults(defineProps<{
  placeholder?: string
  inputClass?: string
  type?: string
  countries?: CountryEntry[]
}>(), {
  type: 'text',
  countries: () => [],
})
const model = defineModel<string>({ required: true })
const emit = defineEmits<{
  (e: 'select-country', code: string): void
}>()

const open = ref(false)
const activeIndex = ref(-1)

function foldDrop(s: string): string {
  return s.toLocaleLowerCase('de').normalize('NFD').replace(/[̀-ͯ]/g, '')
}

type Suggestion =
  | { kind: 'place'; name: string; region: string }
  | { kind: 'country'; code: string; name: string }

const countryMatches = computed<Suggestion[]>(() => {
  const q = foldDrop(model.value.trim())
  if (q.length < 2) return []
  return props.countries
    .filter((c) => foldDrop(c.name).includes(q))
    .map((c) => ({ kind: 'country', code: c.code, name: c.name }))
})

const suggestions = computed<Suggestion[]>(() => {
  const places = filterPlaces(model.value).map((p): Suggestion => ({ kind: 'place', name: p.name, region: p.region }))
  return [...countryMatches.value, ...places].slice(0, 8)
})

function pick(suggestion: Suggestion) {
  if (suggestion.kind === 'country') {
    model.value = ''
    emit('select-country', suggestion.code)
  } else {
    model.value = placeSearchTerm(suggestion.name)
  }
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
    pick(suggestions.value[activeIndex.value]!)
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
      :key="s.kind === 'country' ? `country-${s.code}` : `${s.name}-${s.region}`"
      class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm"
      :class="i === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'"
      @mousedown.prevent="pick(s)"
    >
      <span>
        <span class="font-medium">{{ s.name }}</span>
        <span v-if="s.kind === 'place'" class="text-muted-foreground"> — {{ s.region }}</span>
      </span>
      <span class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {{ s.kind === 'country' ? $t('search.countrySuggestionBadge') : $t('country.de') }}
      </span>
    </li>
  </ul>
</template>
