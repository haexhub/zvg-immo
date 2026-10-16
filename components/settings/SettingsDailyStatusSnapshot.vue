<script setup lang="ts">
import type { DailyStatusSnapshot } from '~/composables/settings/useSettingsStatusOverview'

const props = defineProps<{
  country: string
  snapshots: DailyStatusSnapshot[]
}>()

const { locale, t } = useI18n()
type ChartStatus = 'all' | 'done' | 'pending' | 'open' | 'error'
type Pipeline = 'crawl' | 'llm' | 'translation:de' | 'translation:en' | 'osm'

const chartPeriod = ref('14')
const chartPipeline = ref<Pipeline>('crawl')
const chartStatus = ref<ChartStatus>('all')

const days = computed(() => [...new Set(props.snapshots
  .filter((row) => row.country === props.country)
  .map((row) => row.snapshotDate))].sort((a, b) => b.localeCompare(a)))
const latestDay = computed(() => days.value[0] ?? null)
const previousDay = computed(() => days.value[1] ?? null)
const latestRows = computed(() => props.snapshots
  .filter((row) => row.country === props.country && row.snapshotDate === latestDay.value)
  .sort((a, b) => order(a) - order(b)))
const previousRows = computed(() => new Map(props.snapshots
  .filter((row) => row.country === props.country && row.snapshotDate === previousDay.value)
  .map((row) => [key(row), row])))
const chartRows = computed(() => {
  const [kind, targetLang] = chartPipeline.value.split(':') as [DailyStatusSnapshot['kind'], string | undefined]
  const amount = Number(chartPeriod.value)
  return props.snapshots
    .filter((row) => row.country === props.country && row.kind === kind && (targetLang === undefined || row.targetLang === targetLang))
    .sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate))
    .slice(-amount)
})

function key(row: DailyStatusSnapshot): string {
  return `${row.kind}:${row.targetLang ?? ''}`
}

function order(row: DailyStatusSnapshot): number {
  const base = { crawl: 0, llm: 1, translation: 2, osm: 4 }[row.kind]
  return base + (row.targetLang === 'en' ? 0.1 : row.targetLang === 'de' ? 0.2 : 0)
}

function label(row: DailyStatusSnapshot): string {
  if (row.kind === 'translation') return t('settings.dailySnapshots.translation', { lang: (row.targetLang ?? '').toUpperCase() })
  return t(`settings.dailySnapshots.${row.kind}`)
}

function pipelineLabel(value: Pipeline): string {
  if (value.startsWith('translation:')) return t('settings.dailySnapshots.translation', { lang: value.slice('translation:'.length).toUpperCase() })
  return t(`settings.dailySnapshots.${value}`)
}

function dateLabel(value: string | null): string {
  if (!value) return '–'
  return new Intl.DateTimeFormat(locale.value, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(`${value}T12:00:00Z`))
}

function delta(value: number, previous: number | undefined): string {
  if (previous === undefined) return '–'
  const diff = value - previous
  return diff === 0 ? '0' : `${diff > 0 ? '+' : ''}${diff.toLocaleString(locale.value)}`
}

function deltaClass(value: number, previous: number | undefined, lowerIsBetter = false): string {
  if (previous === undefined || value === previous) return 'text-muted-foreground'
  const improvement = lowerIsBetter ? value < previous : value > previous
  return improvement ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
}
</script>

<template>
  <Card class="overflow-hidden">
    <CardHeader class="pb-3">
      <CardTitle class="text-base">{{ $t('settings.dailySnapshots.title') }}</CardTitle>
      <p class="text-sm text-muted-foreground">
        <template v-if="latestDay">
          <template v-if="previousDay">{{ $t('settings.dailySnapshots.description', { latest: dateLabel(latestDay), previous: dateLabel(previousDay) }) }}</template>
          <template v-else>{{ $t('settings.dailySnapshots.first', { latest: dateLabel(latestDay) }) }}</template>
        </template>
        <template v-else>{{ $t('settings.dailySnapshots.empty') }}</template>
      </p>
    </CardHeader>
    <CardContent v-if="latestDay" class="pt-0">
      <div class="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{{ $t('settings.dailySnapshots.pipeline') }}</TableHead>
              <TableHead class="text-right">{{ $t('settings.statusOverview.bucketDone') }}</TableHead>
              <TableHead class="text-right">{{ $t('settings.statusOverview.bucketPending') }}</TableHead>
              <TableHead class="text-right">{{ $t('settings.statusOverview.bucketOpen') }}</TableHead>
              <TableHead class="text-right">{{ $t('settings.statusOverview.bucketError') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="row in latestRows" :key="key(row)">
              <TableCell class="font-medium">{{ label(row) }}</TableCell>
              <TableCell class="text-right tabular-nums">{{ row.done.toLocaleString(locale) }} <span :class="deltaClass(row.done, previousRows.get(key(row))?.done)">({{ delta(row.done, previousRows.get(key(row))?.done) }})</span></TableCell>
              <TableCell class="text-right tabular-nums">{{ row.pending.toLocaleString(locale) }} <span :class="deltaClass(row.pending, previousRows.get(key(row))?.pending, true)">({{ delta(row.pending, previousRows.get(key(row))?.pending) }})</span></TableCell>
              <TableCell class="text-right tabular-nums">{{ row.open.toLocaleString(locale) }} <span :class="deltaClass(row.open, previousRows.get(key(row))?.open, true)">({{ delta(row.open, previousRows.get(key(row))?.open) }})</span></TableCell>
              <TableCell class="text-right tabular-nums">{{ row.error.toLocaleString(locale) }} <span :class="deltaClass(row.error, previousRows.get(key(row))?.error, true)">({{ delta(row.error, previousRows.get(key(row))?.error) }})</span></TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <p class="mt-2 text-xs text-muted-foreground">{{ $t('settings.dailySnapshots.legend') }}</p>
      <div class="mt-6 border-t pt-5">
        <div class="mb-4 flex flex-wrap gap-2">
          <Select v-model="chartPipeline">
            <SelectTrigger class="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="pipeline in (['crawl', 'llm', 'translation:de', 'translation:en', 'osm'] as Pipeline[])" :key="pipeline" :value="pipeline">{{ pipelineLabel(pipeline) }}</SelectItem>
            </SelectContent>
          </Select>
          <Select v-model="chartStatus">
            <SelectTrigger class="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{{ $t('settings.dailySnapshots.allStatuses') }}</SelectItem>
              <SelectItem v-for="status in (['done', 'pending', 'open', 'error'] as Exclude<ChartStatus, 'all'>[])" :key="status" :value="status">{{ $t(`settings.statusOverview.bucket${status[0]!.toUpperCase()}${status.slice(1)}`) }}</SelectItem>
            </SelectContent>
          </Select>
          <Select v-model="chartPeriod">
            <SelectTrigger class="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">{{ $t('settings.dailySnapshots.days', { count: 7 }) }}</SelectItem>
              <SelectItem value="14">{{ $t('settings.dailySnapshots.days', { count: 14 }) }}</SelectItem>
              <SelectItem value="30">{{ $t('settings.dailySnapshots.days', { count: 30 }) }}</SelectItem>
              <SelectItem value="90">{{ $t('settings.dailySnapshots.days', { count: 90 }) }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p v-if="chartRows.length === 0" class="py-8 text-center text-sm text-muted-foreground">{{ $t('settings.dailySnapshots.chartEmpty') }}</p>
        <SettingsDailyStatusChart v-else :rows="chartRows" :status="chartStatus" />
      </div>
    </CardContent>
  </Card>
</template>
