<script setup lang="ts">
// Environment tab of the Airbnb-style search bar (see SearchBar.vue) — proximity
// to sea/lake/river/mountains/airport (server/utils/osm-proximity.ts,
// same osm_local_elements dataset as the landing page's geo rails, but with
// a user-chosen radius) plus an urban/rural toggle. Draft-staged like
// SearchPropertiesPopover so dragging a slider doesn't refetch on every step.
import { ALL_SCOPE } from '~/lib/auction-constants'
import { useFilterDraft } from '~/composables/useFilterDraft'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

const nearSea = defineModel<number | null>('nearSea', { required: true })
const nearLake = defineModel<number | null>('nearLake', { required: true })
const nearRiver = defineModel<number | null>('nearRiver', { required: true })
const nearMountain = defineModel<number | null>('nearMountain', { required: true })
const nearAirport = defineModel<number | null>('nearAirport', { required: true })
const urbanRural = defineModel<string>('urbanRural', { required: true })

const isOpen = toRef(props, 'open')
const { draft, commit } = useFilterDraft({ nearSea, nearLake, nearRiver, nearMountain, nearAirport, urbanRural }, isOpen)

const SLIDERS = [
  { key: 'nearSea', label: 'searchBar.environment.sea', max: 100 },
  { key: 'nearLake', label: 'searchBar.environment.lake', max: 100 },
  { key: 'nearRiver', label: 'searchBar.environment.river', max: 30 },
  { key: 'nearMountain', label: 'searchBar.environment.mountain', max: 100 },
  { key: 'nearAirport', label: 'searchBar.environment.airport', max: 50 },
] as const

function sliderValue(key: (typeof SLIDERS)[number]['key']): number[] {
  return [draft[key] ?? 0]
}
function setSliderValue(key: (typeof SLIDERS)[number]['key'], value: number[]): void {
  const v = value[0] ?? 0
  draft[key] = v > 0 ? v : null
}

const activeDraftCount = computed(() => {
  let n = 0
  for (const s of SLIDERS) if (draft[s.key] != null) n++
  if (draft.urbanRural !== ALL_SCOPE) n++
  return n
})

function reset(): void {
  for (const s of SLIDERS) draft[s.key] = null
  draft.urbanRural = ALL_SCOPE
}

function apply(): void {
  commit()
  emit('update:open', false)
}
</script>

<template>
  <div class="flex h-full flex-col md:h-auto md:max-h-[70vh]">
    <div class="flex-1 overflow-y-auto space-y-6 pb-4">
      <div v-for="s in SLIDERS" :key="s.key" class="space-y-2">
        <div class="flex items-center justify-between">
          <Label>{{ $t(s.label) }}</Label>
          <span class="text-sm text-muted-foreground">
            {{ draft[s.key] != null ? $t('searchBar.environment.withinKm', { km: draft[s.key] }) : $t('searchBar.environment.any') }}
          </span>
        </div>
        <Slider
          :model-value="sliderValue(s.key)"
          :max="s.max"
          :step="1"
          @update:model-value="setSliderValue(s.key, $event ?? [0])"
        />
      </div>

      <div class="space-y-2 border-t pt-4">
        <Label>{{ $t('searchBar.environment.urbanRural') }}</Label>
        <div class="flex gap-2">
          <button
            v-for="opt in [ALL_SCOPE, 'urban', 'rural']"
            :key="opt"
            type="button"
            class="flex-1 rounded-md border px-3 py-2 text-sm transition-colors"
            :class="draft.urbanRural === opt ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:border-primary/50'"
            @click="draft.urbanRural = opt"
          >
            {{ opt === ALL_SCOPE ? $t('searchBar.environment.either') : opt === 'urban' ? $t('searchBar.environment.urban') : $t('searchBar.environment.rural') }}
          </button>
        </div>
      </div>
    </div>

    <div class="flex gap-3 border-t pt-4">
      <Button
        type="button"
        variant="outline"
        class="flex-1 border-destructive text-destructive hover:bg-destructive hover:text-white"
        :disabled="activeDraftCount === 0"
        @click="reset"
      >
        {{ $t('filters.reset', { count: activeDraftCount }) }}
      </Button>
      <Button type="button" class="flex-1" @click="apply">
        {{ $t('searchBar.apply') }}
      </Button>
    </div>
  </div>
</template>
