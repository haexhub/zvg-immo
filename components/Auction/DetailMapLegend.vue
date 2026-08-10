<script setup lang="ts">
// One row shape, one <img> box, for every legend entry — the icons/legend
// used to be three separate hand-rolled markup patterns in DetailMap.client
// (a plain <img>, an inline mapPinDataUri() call, and a hand-drawn <span>
// circle for the odor swatch), each sized/aligned by hand. That's how the
// odor and subject rows drifted out of alignment with the rest: every entry
// funnels through this one row template now, so a future entry can't repeat
// that by construction.
interface LegendEntry {
  key: string
  label: string
  icon: string
}

type LegendRow =
  | { type: 'header', key: string, text: string }
  | { type: 'row', key: string, icon: string, label: string, hoverGroup?: 'feature' | 'hazard', hoverKey?: string }

const props = defineProps<{
  featureEntries: LegendEntry[]
  hazardEntries: LegendEntry[]
  showOdor: boolean
  subjectIcon: string
  subjectLabel: string
  hazardsTitle: string
  odorIcon: string
  odorLabel: string
  toggleClass: string
  panelClass: string
  toggleLabel: string
}>()

const emit = defineEmits<{
  hoverFeature: [key: string | null]
  hoverHazard: [key: string | null]
}>()

const open = defineModel<boolean>('open', { default: true })

const rows = computed<LegendRow[]>(() => {
  const list: LegendRow[] = [{ type: 'row', key: 'subject', icon: props.subjectIcon, label: props.subjectLabel }]
  for (const entry of props.featureEntries) {
    list.push({ type: 'row', key: `feature:${entry.key}`, icon: entry.icon, label: entry.label, hoverGroup: 'feature', hoverKey: entry.key })
  }
  if (props.hazardEntries.length) {
    list.push({ type: 'header', key: 'hazards-header', text: props.hazardsTitle })
    for (const entry of props.hazardEntries) {
      list.push({ type: 'row', key: `hazard:${entry.key}`, icon: entry.icon, label: entry.label, hoverGroup: 'hazard', hoverKey: entry.key })
    }
  }
  if (props.showOdor) {
    list.push({ type: 'row', key: 'odor', icon: props.odorIcon, label: props.odorLabel })
  }
  return list
})

function onEnter(row: LegendRow): void {
  if (row.type !== 'row' || row.hoverKey === undefined) return
  if (row.hoverGroup === 'feature') emit('hoverFeature', row.hoverKey)
  else if (row.hoverGroup === 'hazard') emit('hoverHazard', row.hoverKey)
}

function onLeave(row: LegendRow): void {
  if (row.type !== 'row') return
  if (row.hoverGroup === 'feature') emit('hoverFeature', null)
  else if (row.hoverGroup === 'hazard') emit('hoverHazard', null)
}
</script>

<template>
  <div class="absolute bottom-2 left-2 z-10 flex flex-col items-start gap-1">
    <button
      type="button"
      :class="toggleClass"
      :aria-expanded="open"
      aria-controls="auction-detail-map-legend-panel"
      @click="open = !open"
    >
      {{ toggleLabel }}
    </button>
    <div v-if="open" id="auction-detail-map-legend-panel" :class="panelClass">
      <template v-for="row in rows" :key="row.key">
        <div v-if="row.type === 'header'" class="mt-1 border-t border-slate-900/10 pt-1 font-semibold">{{ row.text }}</div>
        <div
          v-else
          class="-mx-1 flex min-h-6 items-center gap-1.5 rounded px-1"
          :class="{ 'hover:bg-slate-900/10': row.hoverGroup }"
          @mouseenter="onEnter(row)"
          @mouseleave="onLeave(row)"
        >
          <img :src="row.icon" alt="" class="h-6 w-6 shrink-0">
          {{ row.label }}
        </div>
      </template>
    </div>
  </div>
</template>
