<script setup lang="ts">
import { TOURISM_NUTS_BIN_COLORS, TOURISM_NUTS_NO_DATA_COLOR } from '~/lib/tourism-nuts-categories'

// A simple on/off toggle, not a picker like AuctionTourismLegend's category
// swatch-list: this layer has exactly one metric, so there is nothing to
// select between. Kept as its own sibling component (not folded into
// TourismLegend's model) — see Map.client.vue's watch pair for why the two
// layers are exclusive on the map despite living in separate components.
const active = defineModel<boolean>('active', { required: true })

const props = defineProps<{
  breaks: number[]
}>()

const { t } = useI18n()
const intlLocale = useIntlLocale()
const open = ref(false)

function formatValue(n: number): string {
  return n.toLocaleString(intlLocale.value, { maximumFractionDigits: 0 })
}

// One swatch per bin color, labelled with the half-open range it covers —
// the "scale legend" the dataviz skill calls for on a continuous/binned
// numeric layer, as opposed to a category picker.
const bins = computed(() => TOURISM_NUTS_BIN_COLORS.map((color, index) => {
  const lower = index > 0 ? props.breaks[index - 1] : undefined
  const upper = index < props.breaks.length ? props.breaks[index] : undefined
  const label = lower != null && upper != null
    ? `${formatValue(lower)}–${formatValue(upper)}`
    : upper != null
      ? `< ${formatValue(upper)}`
      : lower != null
        ? `> ${formatValue(lower)}`
        : ''
  return { color, label }
}))
</script>

<template>
  <div class="absolute bottom-2 left-32 z-10 flex flex-col items-start gap-1">
    <button
      type="button"
      class="cursor-pointer rounded-md border border-slate-900/15 bg-white/95 px-2.5 py-1 text-xs font-semibold text-gray-900 shadow-sm"
      :aria-expanded="open"
      aria-controls="tourism-visitor-legend-panel"
      @click="open = !open"
    >
      {{ t('map.tourismVisitorToggle') }}
    </button>
    <div
      v-if="open"
      id="tourism-visitor-legend-panel"
      class="w-56 rounded-md border border-slate-900/15 bg-white/95 px-2 py-1.5 text-xs leading-tight text-gray-900 shadow-sm backdrop-blur-sm"
    >
      <button
        type="button"
        class="mb-1.5 w-full cursor-pointer rounded px-1 py-1 text-left hover:bg-slate-900/10"
        :class="{ 'bg-slate-900/10 font-semibold': active }"
        @click="active = !active"
      >
        {{ t('map.tourismVisitorUnit') }}
      </button>
      <div class="flex gap-0.5">
        <div v-for="(bin, index) in bins" :key="index" class="flex-1 text-center">
          <span class="block h-3 w-full rounded-sm" :style="{ backgroundColor: bin.color }" />
          <span class="mt-0.5 block truncate text-[9px] text-gray-500">{{ bin.label }}</span>
        </div>
      </div>
      <div class="mt-1.5 flex items-center gap-1.5 border-t border-slate-900/10 pt-1.5">
        <span class="h-3 w-3 shrink-0 rounded-sm" :style="{ backgroundColor: TOURISM_NUTS_NO_DATA_COLOR }" />
        <span class="text-gray-500">{{ t('map.tourismVisitorNoData') }}</span>
      </div>
      <button
        type="button"
        class="mt-1 w-full cursor-pointer rounded border-t border-slate-900/10 px-1 pt-1.5 text-left text-gray-500 hover:bg-slate-900/10"
        @click="active = false"
      >
        {{ t('map.tourismLayerOff') }}
      </button>
      <p class="mt-1.5 border-t border-slate-900/10 pt-1.5 text-[9px] leading-snug text-gray-400">
        {{ t('map.tourismVisitorAttribution') }}
      </p>
    </div>
  </div>
</template>
