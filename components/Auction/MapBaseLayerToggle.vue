<script setup lang="ts">
// Extracted out of Map.client.vue (which sits at the CI size gate's 500-line
// cap) to make room for the tourism-layer wiring — same markup/behaviour as
// before, just its own component.
const model = defineModel<'streets' | 'satellite'>({ required: true })
const { t } = useI18n()
</script>

<template>
  <div class="absolute top-2 right-2 z-10 flex overflow-hidden rounded-md border border-slate-900/15 bg-white shadow-sm">
    <button
      type="button"
      class="cursor-pointer px-2.5 py-1 text-xs font-semibold"
      :class="model === 'streets' ? 'bg-blue-600 text-white' : 'bg-transparent text-gray-800'"
      @click="model = 'streets'"
    >
      {{ t('map.baseLayerStreets') }}
    </button>
    <button
      type="button"
      class="cursor-pointer px-2.5 py-1 text-xs font-semibold"
      :class="model === 'satellite' ? 'bg-blue-600 text-white' : 'bg-transparent text-gray-800'"
      @click="model = 'satellite'"
    >
      {{ t('map.baseLayerSatellite') }}
    </button>
  </div>
</template>
