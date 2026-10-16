<script setup lang="ts">
import {
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js'
import { Chart } from 'vue-chartjs'
import type { DailyStatusSnapshot } from '~/composables/settings/useSettingsStatusOverview'

type ChartStatus = 'all' | 'done' | 'pending' | 'open' | 'error'

const props = defineProps<{
  rows: DailyStatusSnapshot[]
  status: ChartStatus
}>()

const { locale, t } = useI18n()
ChartJS.register(CategoryScale, LineController, LineElement, LinearScale, PointElement, Tooltip, Legend)

const series = [
  { key: 'done', color: '#0ca30c' },
  { key: 'pending', color: '#3b82f6' },
  { key: 'open', color: '#fab219' },
  { key: 'error', color: '#d03b3b' },
] as const

const visibleSeries = computed(() => props.status === 'all'
  ? series
  : series.filter((item) => item.key === props.status))

function formatDay(day: string): string {
  return new Intl.DateTimeFormat(locale.value, { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`))
}

const chartData = computed(() => ({
  labels: props.rows.map((row) => formatDay(row.snapshotDate)),
  datasets: visibleSeries.value.map((item) => ({
    label: t(`settings.statusOverview.bucket${item.key[0]!.toUpperCase()}${item.key.slice(1)}`),
    data: props.rows.map((row) => row[item.key]),
    borderColor: item.color,
    backgroundColor: item.color,
    borderWidth: 2,
    pointRadius: 3,
    pointHoverRadius: 5,
    tension: 0.25,
  })),
}))

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  locale: locale.value,
  plugins: {
    legend: { display: props.status === 'all', position: 'bottom' as const, labels: { usePointStyle: true, boxWidth: 8 } },
    tooltip: {
      backgroundColor: '#fcfcfb', titleColor: '#0b0b0b', bodyColor: '#0b0b0b',
      borderColor: '#c3c2b7', borderWidth: 1, padding: 10,
      callbacks: { label: (ctx: { dataset: { label?: string }; parsed: { y: number | null } }) => `${ctx.dataset.label}: ${(ctx.parsed.y ?? 0).toLocaleString(locale.value)}` },
    },
  },
  scales: {
    x: { grid: { display: false }, ticks: { color: '#52514e', maxRotation: 0 } },
    y: { beginAtZero: true, grid: { color: '#e1e0d9' }, ticks: { color: '#52514e', precision: 0 } },
  },
}))
</script>

<template>
  <div class="h-64 w-full">
    <Chart type="line" :data="chartData" :options="chartOptions" />
  </div>
</template>
