<script setup lang="ts">
// Environment tab of the Airbnb-style search bar (see SearchBar.vue) —
// proximity to sea/lake/river/mountains/airport/ski (server/utils/
// osm-proximity.ts and geo-metric-categories.ts) plus an urban/rural toggle.
// Every slider/button writes straight to the real, URL-synced refs — no
// buffering, since none of these fields need per-keystroke debouncing.
import { ALL_SCOPE } from '~/lib/auction-constants'

const nearSea = defineModel<number | null>('nearSea', { required: true })
const nearLake = defineModel<number | null>('nearLake', { required: true })
const nearRiver = defineModel<number | null>('nearRiver', { required: true })
const nearMountain = defineModel<number | null>('nearMountain', { required: true })
const nearAirport = defineModel<number | null>('nearAirport', { required: true })
const nearSkiDownhill = defineModel<number | null>('nearSkiDownhill', { required: true })
const nearSkiNordic = defineModel<number | null>('nearSkiNordic', { required: true })
const urbanRural = defineModel<string>('urbanRural', { required: true })

const models = { nearSea, nearLake, nearRiver, nearMountain, nearAirport, nearSkiDownhill, nearSkiNordic }

const SLIDERS = [
  { key: 'nearSea', label: 'searchBar.environment.sea', max: 100 },
  { key: 'nearLake', label: 'searchBar.environment.lake', max: 100 },
  { key: 'nearRiver', label: 'searchBar.environment.river', max: 30 },
  { key: 'nearMountain', label: 'searchBar.environment.mountain', max: 100 },
  { key: 'nearAirport', label: 'searchBar.environment.airport', max: 50 },
  { key: 'nearSkiDownhill', label: 'searchBar.environment.skiDownhill', max: 100 },
  { key: 'nearSkiNordic', label: 'searchBar.environment.skiNordic', max: 100 },
] as const

function sliderValue(key: (typeof SLIDERS)[number]['key']): number[] {
  return [models[key].value ?? 0]
}
function setSliderValue(key: (typeof SLIDERS)[number]['key'], value: number[]): void {
  const v = value[0] ?? 0
  models[key].value = v > 0 ? v : null
}
</script>

<template>
  <div class="flex h-full flex-col md:h-auto md:max-h-[70vh]">
    <div class="flex-1 overflow-y-auto space-y-6 p-1 pr-4 pb-4">
      <div v-for="s in SLIDERS" :key="s.key" class="space-y-2">
        <div class="flex items-center justify-between">
          <Label>{{ $t(s.label) }}</Label>
          <span class="text-sm text-muted-foreground">
            {{ models[s.key].value != null ? $t('searchBar.environment.withinKm', { km: models[s.key].value }) : $t('searchBar.environment.any') }}
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
            :class="urbanRural === opt ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:border-primary/50'"
            @click="urbanRural = opt"
          >
            {{ opt === ALL_SCOPE ? $t('searchBar.environment.either') : opt === 'urban' ? $t('searchBar.environment.urban') : $t('searchBar.environment.rural') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
