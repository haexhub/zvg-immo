<script setup lang="ts">
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartData,
  type ChartOptions,
} from 'chart.js'
import { Chart } from 'vue-chartjs'
import type { LocationClimateNormals } from '~/types/auction'

ChartJS.register(BarController, LineController, BarElement, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend)

const props = defineProps<{
  normals: LocationClimateNormals
}>()

const { t } = useI18n()
const intlLocale = useIntlLocale()

// No dark-mode toggle exists anywhere in this app yet (no .dark class is
// ever set, despite the dark: utility classes some components carry — the
// custom-variant in assets/css/tailwind.css is class-based, not a
// prefers-color-scheme media query), so every page renders with these light
// colors today regardless of OS setting. Fixed categorical slots 1-4 (blue,
// orange, aqua, yellow) from the project's validated data-viz palette,
// assigned in order — not hand-picked to mimic a reference image, so the
// adjacency/CVD guarantees still hold.
const colors = {
  precip: '#2a78d6',
  tempMax: '#eb6834',
  tempMean: '#1baf7a',
  tempMin: '#eda100',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  text: '#52514e',
  surface: '#fcfcfb',
  ink: '#0b0b0b',
}

const monthLabels = computed(() => props.normals.months.map((m) =>
  new Date(Date.UTC(2000, m.month - 1, 1)).toLocaleDateString(intlLocale.value, { month: 'short', timeZone: 'UTC' })))

const chartData = computed<ChartData<'bar' | 'line'>>(() => ({
  labels: monthLabels.value,
  datasets: [
    {
      type: 'bar' as const,
      label: t('objektDetail.climatePrecipitation'),
      data: props.normals.months.map((m) => m.precipitationAvgMm),
      backgroundColor: colors.precip,
      borderRadius: 4,
      maxBarThickness: 24,
      yAxisID: 'precip',
      order: 4,
    },
    {
      type: 'line' as const,
      label: t('objektDetail.climateTempMax'),
      data: props.normals.months.map((m) => m.tempMaxAvgC),
      borderColor: colors.tempMax,
      backgroundColor: colors.tempMax,
      borderWidth: 2,
      pointRadius: 4,
      pointBorderColor: colors.surface,
      pointBorderWidth: 2,
      tension: 0.3,
      yAxisID: 'temp',
      order: 1,
    },
    {
      type: 'line' as const,
      label: t('objektDetail.climateTempMean'),
      data: props.normals.months.map((m) => m.tempMeanAvgC),
      borderColor: colors.tempMean,
      backgroundColor: colors.tempMean,
      borderWidth: 2,
      pointRadius: 4,
      pointBorderColor: colors.surface,
      pointBorderWidth: 2,
      tension: 0.3,
      yAxisID: 'temp',
      order: 2,
    },
    {
      type: 'line' as const,
      label: t('objektDetail.climateTempMin'),
      data: props.normals.months.map((m) => m.tempMinAvgC),
      borderColor: colors.tempMin,
      backgroundColor: colors.tempMin,
      borderWidth: 2,
      pointRadius: 4,
      pointBorderColor: colors.surface,
      pointBorderWidth: 2,
      tension: 0.3,
      yAxisID: 'temp',
      order: 3,
    },
  ],
}))

const chartOptions = computed<ChartOptions<'bar' | 'line'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  locale: intlLocale.value,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: {
      position: 'bottom',
      labels: { color: colors.text, usePointStyle: true, boxHeight: 8, boxWidth: 8, padding: 16 },
    },
    tooltip: {
      backgroundColor: colors.surface,
      titleColor: colors.ink,
      bodyColor: colors.ink,
      borderColor: colors.axis,
      borderWidth: 1,
      padding: 10,
      callbacks: {
        label: (ctx) => `${ctx.dataset.label}: ${ctx.formattedValue}${ctx.dataset.yAxisID === 'precip' ? ' mm' : ' °C'}`,
      },
    },
  },
  scales: {
    x: {
      grid: { display: false },
      ticks: { color: colors.text },
    },
    temp: {
      type: 'linear',
      position: 'left',
      grid: { color: colors.grid },
      ticks: { color: colors.text, callback: (v) => `${v}°C` },
    },
    precip: {
      type: 'linear',
      position: 'right',
      beginAtZero: true,
      grid: { display: false },
      ticks: { color: colors.text, callback: (v) => `${v} mm` },
    },
  },
}))

function formatTemp(n: number): string {
  return `${n.toLocaleString(intlLocale.value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C`
}
function formatPrecip(n: number): string {
  return `${n.toLocaleString(intlLocale.value, { maximumFractionDigits: 0 })} mm`
}
</script>

<template>
  <div class="space-y-4">
    <div class="h-72 w-full">
      <Chart type="bar" :data="chartData" :options="chartOptions" />
    </div>
    <div class="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="whitespace-nowrap">{{ $t('objektDetail.climateMonth') }}</TableHead>
            <TableHead v-for="(label, i) in monthLabels" :key="i" class="text-right tabular-nums">{{ label }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell class="whitespace-nowrap font-medium">{{ $t('objektDetail.climateTempMax') }}</TableCell>
            <TableCell v-for="m in normals.months" :key="m.month" class="text-right tabular-nums">{{ formatTemp(m.tempMaxAvgC) }}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell class="whitespace-nowrap font-medium">{{ $t('objektDetail.climateTempMean') }}</TableCell>
            <TableCell v-for="m in normals.months" :key="m.month" class="text-right tabular-nums">{{ formatTemp(m.tempMeanAvgC) }}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell class="whitespace-nowrap font-medium">{{ $t('objektDetail.climateTempMin') }}</TableCell>
            <TableCell v-for="m in normals.months" :key="m.month" class="text-right tabular-nums">{{ formatTemp(m.tempMinAvgC) }}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell class="whitespace-nowrap font-medium">{{ $t('objektDetail.climatePrecipitation') }}</TableCell>
            <TableCell v-for="m in normals.months" :key="m.month" class="text-right tabular-nums">{{ formatPrecip(m.precipitationAvgMm) }}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
    <p class="text-xs text-muted-foreground">
      {{ $t('objektDetail.climateNormalsHint', { start: normals.periodStartYear, end: normals.periodEndYear }) }}
    </p>
  </div>
</template>
