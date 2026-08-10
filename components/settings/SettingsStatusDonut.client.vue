<script setup lang="ts">
// Compact 3-segment status donut (done/open/error) for the /settings
// crawl- and LLM-status cards. Chart.js provides the glanceable visual +
// hover tooltip; the real interaction (selecting a segment, keyboard/
// screen-reader reachable) is the HTML legend list below it, per
// dataviz-skill's status-color rule: a status color never carries meaning
// alone, it's always paired with an icon + label.
import { ArcElement, Chart as ChartJS, DoughnutController, Tooltip } from 'chart.js'
import { AlertCircle, CheckCircle2, Clock } from 'lucide-vue-next'
import { Chart } from 'vue-chartjs'
import type { StatusBucket, StatusCounts } from '~/composables/settings/useSettingsStatusOverview'

ChartJS.register(DoughnutController, ArcElement, Tooltip)

const props = defineProps<{
  counts: StatusCounts
  selected: StatusBucket | null
  size?: number
}>()

const emit = defineEmits<{ select: [bucket: StatusBucket] }>()

const { t } = useI18n()

// Fixed reserved status roles (dataviz-skill palette.md) — never themed,
// never reused for anything else. Traffic-light order: done=good,
// open=warning (still pending, not yet failed), error=critical.
const BUCKETS: { key: StatusBucket; color: string; icon: typeof CheckCircle2 }[] = [
  { key: 'done', color: '#0ca30c', icon: CheckCircle2 },
  { key: 'open', color: '#fab219', icon: Clock },
  { key: 'error', color: '#d03b3b', icon: AlertCircle },
]

const bucketLabel = computed<Record<StatusBucket, string>>(() => ({
  done: t('settings.statusOverview.bucketDone'),
  open: t('settings.statusOverview.bucketOpen'),
  error: t('settings.statusOverview.bucketError'),
}))

const chartData = computed(() => ({
  labels: BUCKETS.map((b) => bucketLabel.value[b.key]),
  datasets: [{
    data: BUCKETS.map((b) => props.counts[b.key]),
    backgroundColor: BUCKETS.map((b) => b.color),
    borderColor: '#fcfcfb',
    borderWidth: 2,
    hoverOffset: 4,
  }],
}))

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  cutout: '65%',
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: '#fcfcfb',
      titleColor: '#0b0b0b',
      bodyColor: '#0b0b0b',
      borderColor: '#c3c2b7',
      borderWidth: 1,
      padding: 8,
      callbacks: {
        label: (ctx: { label: string; parsed: number }) => `${ctx.label}: ${ctx.parsed}`,
      },
    },
  },
  onClick: (_evt: unknown, elements: { index: number }[]) => {
    const el = elements[0]
    const bucket = el && BUCKETS[el.index]
    if (bucket) emit('select', bucket.key)
  },
}))

function toggle(bucket: StatusBucket): void {
  emit('select', bucket)
}
</script>

<template>
  <div class="flex items-center gap-3">
    <div :style="{ width: `${size ?? 64}px`, height: `${size ?? 64}px` }" class="shrink-0">
      <Chart type="doughnut" :data="chartData" :options="chartOptions" />
    </div>
    <ul class="flex flex-col gap-0.5 text-xs">
      <li v-for="bucket in BUCKETS" :key="bucket.key">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/60"
          :class="{ 'bg-muted font-medium': selected === bucket.key }"
          :aria-pressed="selected === bucket.key"
          @click="toggle(bucket.key)"
        >
          <component :is="bucket.icon" class="h-3.5 w-3.5 shrink-0" :style="{ color: bucket.color }" />
          <span class="text-muted-foreground">{{ bucketLabel[bucket.key] }}</span>
          <span class="tabular-nums font-medium text-foreground">{{ counts[bucket.key] }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
