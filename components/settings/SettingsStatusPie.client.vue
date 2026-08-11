<script setup lang="ts">
import { ArcElement, Chart as ChartJS, PieController, Tooltip } from 'chart.js'
import { Chart } from 'vue-chartjs'

export interface StatusPieSegment {
  key: string
  label: string
  color: string
  value: number
}

const props = defineProps<{
  segments: StatusPieSegment[]
  selected?: string | null
  size?: number
}>()

const emit = defineEmits<{ select: [key: string] }>()

const { locale } = useI18n()

ChartJS.register(PieController, ArcElement, Tooltip)

const chartData = computed(() => ({
  labels: props.segments.map((segment) => segment.label),
  datasets: [{
    data: props.segments.map((segment) => segment.value),
    backgroundColor: props.segments.map((segment) => segment.color),
    borderColor: '#fcfcfb',
    borderWidth: 3,
    hoverOffset: 8,
  }],
}))

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: '#fcfcfb',
      titleColor: '#0b0b0b',
      bodyColor: '#0b0b0b',
      borderColor: '#c3c2b7',
      borderWidth: 1,
      padding: 10,
      caretPadding: 10,
      displayColors: false,
      callbacks: {
        label: (ctx: { label: string; parsed: number }) => `${ctx.label}: ${ctx.parsed.toLocaleString(locale.value)}`,
      },
    },
  },
  onClick: (_event: unknown, elements: { index: number }[]) => {
    const segment = elements[0] && props.segments[elements[0].index]
    if (segment) emit('select', segment.key)
  },
}))
</script>

<template>
  <div class="flex flex-col items-center gap-3">
    <div :style="{ width: `${size ?? 208}px`, height: `${size ?? 208}px` }" class="max-w-full shrink-0" aria-hidden="true">
      <Chart type="pie" :data="chartData" :options="chartOptions" />
    </div>
    <ul class="grid w-full gap-1 text-sm">
      <li v-for="segment in segments" :key="segment.key">
        <button
          type="button"
          class="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted/60"
          :class="{ 'bg-muted font-medium': selected === segment.key }"
          :aria-pressed="selected === segment.key"
          @click="emit('select', segment.key)"
        >
          <span class="flex min-w-0 items-center gap-2">
            <span class="h-3 w-3 shrink-0 rounded-sm" :style="{ backgroundColor: segment.color }" />
            <span class="truncate text-muted-foreground">{{ segment.label }}</span>
          </span>
          <span class="shrink-0 tabular-nums text-foreground">{{ segment.value.toLocaleString(locale) }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
