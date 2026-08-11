<script setup lang="ts">
// Daily LLM spend trend for the /settings cost card. Single series (cost per
// day) — no legend needed, the card title already names it (dataviz-skill:
// a lone series skips the legend box). .client.vue like the other two chart
// components in this app (SettingsStatusDonut, ClimateNormalsChart) so
// Chart.js's canvas never has to survive SSR/hydration.
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  LinearScale,
  Tooltip,
} from 'chart.js'
import { Chart } from 'vue-chartjs'
import type { LlmCostDailyRow } from '~/server/utils/llm-usage'

ChartJS.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip)

const props = defineProps<{
  daily: LlmCostDailyRow[]
}>()

const intlLocale = useIntlLocale()

// Same validated single-hue slot ClimateNormalsChart uses for its bar series
// (project data-viz palette) plus the shared grid/axis/surface/ink tokens —
// kept identical across every chart in this app rather than re-derived here.
const colors = {
  cost: '#2a78d6',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  text: '#52514e',
  surface: '#fcfcfb',
  ink: '#0b0b0b',
}

function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(intlLocale.value, { day: '2-digit', month: '2-digit', timeZone: 'UTC' })
}
function formatCost(value: number | null): string {
  if (value == null) return '—'
  return value.toLocaleString(intlLocale.value, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

const chartData = computed(() => ({
  labels: props.daily.map((d) => formatDay(d.day)),
  datasets: [{
    data: props.daily.map((d) => d.costUsd),
    backgroundColor: colors.cost,
    borderRadius: 4,
    maxBarThickness: 24,
  }],
}))

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  locale: intlLocale.value,
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: colors.surface,
      titleColor: colors.ink,
      bodyColor: colors.ink,
      borderColor: colors.axis,
      borderWidth: 1,
      padding: 10,
      callbacks: {
        label: (ctx: { parsed: { y: number | null } }) => formatCost(ctx.parsed.y),
      },
    },
  },
  scales: {
    x: { grid: { display: false }, ticks: { color: colors.text } },
    y: {
      beginAtZero: true,
      grid: { color: colors.grid },
      ticks: { color: colors.text, callback: (v: string | number) => formatCost(Number(v)) },
    },
  },
}))
</script>

<template>
  <div class="h-48 w-full">
    <Chart type="bar" :data="chartData" :options="chartOptions" />
  </div>
</template>
