<script setup lang="ts">
import { Loader2, RefreshCw } from 'lucide-vue-next'
import { useSettingsError } from '~/composables/settings/useSettingsError'
import { useSettingsTaskOverview } from '~/composables/settings/useSettingsTaskOverview'
import type { CountrySourceSetting, CountrySourceSettings } from '~/server/utils/country-source-settings'

interface EnrichRunResult {
  crawled: number
  todo: number
  archived: number
  enriched: number
  photoExtractions: number
  photosTotal: number
  durationMs: number
  warning?: string | null
  followUpTasksStarted?: boolean
}

const { t } = useI18n()
const countryLabel = useCountryLabel()
const { normalizeSettingsError } = useSettingsError()
const {
  llmBatchJobs,
  llmBatchJobsPending,
  llmBatchJobsError,
  formatBatchDate,
  loadLlmBatchJobs,
  startProgressPolling,
  stopProgressPolling,
} = useSettingsTaskOverview()

const countrySources = ref<CountrySourceSetting[]>([])
const countrySourcesPending = ref(false)
const countrySourcesError = ref<string | null>(null)
const countrySourcesSaved = ref(false)
const countrySourcesLoaded = ref(false)
const countryEnrichPending = ref<string | null>(null)
const countryEnrichError = ref<string | null>(null)
const countryEnrichResult = ref<EnrichRunResult & { country: string } | null>(null)
const forceCountryExtraction = ref(false)
const enabledCountrySourceCount = computed(
  () => countrySources.value.filter((source) => source.enabled).length,
)

function progressNumber(value: number | string | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function percentOf(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100
}

interface CrawlCountryRow {
  code: string
  label: string
  regionsDone: number
  regionsTotal: number
  archivedDone: number
  archivedTotal: number
  percent: number
}

const crawlProgressByCountry = computed<CrawlCountryRow[]>(() => {
  const byCountry = llmBatchJobs.value?.enrichStatus?.progressByCountry
  if (!byCountry) return []
  return Object.entries(byCountry)
    .map(([code, p]) => {
      const regionsDone = progressNumber(p.regionsDone)
      const regionsTotal = progressNumber(p.regionsTotal)
      const archivedDone = progressNumber(p.archivedDone)
      const archivedTotal = progressNumber(p.archivedTotal)
      return {
        code,
        label: countryLabel(code),
        regionsDone,
        regionsTotal,
        archivedDone,
        archivedTotal,
        // A run crawls all sources first and only then knows how many
        // listings there are to archive, so archivedTotal is 0 for the whole
        // first phase — track the phase that is actually running, otherwise
        // every bar sits at 100% while the crawl has barely started.
        percent: archivedTotal > 0
          ? percentOf(archivedDone, archivedTotal)
          : percentOf(regionsDone, regionsTotal),
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'de'))
})

interface LlmCountryRow {
  code: string
  label: string
  done: number
  total: number
  percent: number
  llmCalls: number
  llmErrors: number
}

const llmProgressByCountry = computed<LlmCountryRow[]>(() => {
  const byCountry = llmBatchJobs.value?.reprocessStatus?.progressByCountry
  if (!byCountry) return []
  return Object.entries(byCountry)
    .map(([code, p]) => {
      const done = progressNumber(p.processed) + progressNumber(p.skipped)
      const total = progressNumber(p.candidatesTotal)
      return {
        code,
        label: countryLabel(code),
        done,
        total,
        percent: percentOf(done, total),
        llmCalls: progressNumber(p.llmCalls),
        llmErrors: progressNumber(p.llmErrors),
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'de'))
})

async function loadCountrySources(): Promise<void> {
  try {
    const res = await $fetch<CountrySourceSettings>('/api/settings/countries')
    countrySources.value = res.countries
    countrySourcesLoaded.value = true
    countrySourcesError.value = null
  } catch (err) {
    countrySourcesLoaded.value = false
    countrySourcesError.value = normalizeSettingsError(err, t('settings.sources.loadError'))
  }
}

function toggleCountrySource(code: string): void {
  const source = countrySources.value.find((candidate) => candidate.code === code)
  if (source) source.enabled = !source.enabled
  countrySourcesSaved.value = false
}

async function saveCountrySources(): Promise<void> {
  if (!countrySourcesLoaded.value) return
  countrySourcesPending.value = true
  countrySourcesError.value = null
  countrySourcesSaved.value = false
  try {
    const res = await $fetch<CountrySourceSettings>('/api/settings/countries', {
      method: 'PUT',
      body: {
        enabledCountries: countrySources.value
          .filter((source) => source.enabled)
          .map((source) => source.code),
      },
    })
    countrySources.value = res.countries
    countrySourcesSaved.value = true
  } catch (err) {
    countrySourcesError.value = normalizeSettingsError(err, t('settings.sources.saveError'))
  } finally {
    countrySourcesPending.value = false
  }
}

async function enrichCountrySource(source: CountrySourceSetting): Promise<void> {
  if (!source.enabled || countryEnrichPending.value) return

  countryEnrichPending.value = source.code
  countryEnrichError.value = null
  countryEnrichResult.value = null
  startProgressPolling()
  try {
    const res = await $fetch<{ result: EnrichRunResult }>(
      `/api/settings/countries/${source.code}/enrich`,
      {
        method: 'POST',
        body: { forceExtraction: forceCountryExtraction.value },
      },
    )
    countryEnrichResult.value = { ...res.result, country: source.code }
    await loadLlmBatchJobs()
  } catch (err) {
    countryEnrichError.value = normalizeSettingsError(err, t('settings.sources.enrichError'))
  } finally {
    countryEnrichPending.value = null
  }
}

onMounted(async () => {
  await Promise.all([loadCountrySources(), loadLlmBatchJobs()])
})
onBeforeUnmount(stopProgressPolling)
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ $t('settings.sources.title') }}</CardTitle>
      <CardAction>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          :disabled="llmBatchJobsPending"
          :title="$t('settings.sources.refreshOverview')"
          @click="loadLlmBatchJobs"
        >
          <Loader2 v-if="llmBatchJobsPending" class="h-4 w-4 animate-spin" />
          <RefreshCw v-else class="h-4 w-4" />
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">
        {{ $t('settings.sources.description') }}
      </p>

      <p v-if="countrySourcesError" class="text-sm text-destructive">{{ countrySourcesError }}</p>
      <p v-if="countryEnrichError" class="text-sm text-destructive">{{ countryEnrichError }}</p>
      <p v-if="llmBatchJobsError" class="text-sm text-destructive">{{ llmBatchJobsError }}</p>
      <p v-if="countrySourcesSaved" class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('settings.sources.saved') }}</p>
      <p v-if="countryEnrichResult" class="text-sm text-emerald-600 dark:text-emerald-500">
        {{ $t('settings.sources.enrichDone', {
          country: countryLabel(countryEnrichResult.country),
          archived: countryEnrichResult.archived,
          crawled: countryEnrichResult.crawled,
          photos: countryEnrichResult.photosTotal,
          duration: Math.round(countryEnrichResult.durationMs / 1000),
        }) }}
      </p>
      <p v-if="countryEnrichResult?.warning" role="alert" class="text-sm text-amber-600 dark:text-amber-400">
        {{ countryEnrichResult.warning }}
      </p>
      <p v-if="countryEnrichResult?.followUpTasksStarted" class="text-sm text-muted-foreground">
        {{ $t('settings.sources.followUpTasksStarted') }}
      </p>

      <div v-if="llmBatchJobs?.enrichStatus" class="text-sm space-y-1">
        <p v-if="llmBatchJobs.enrichStatus.status === 'running'">
          {{ $t('settings.sources.enrichStatusRunning', { at: formatBatchDate(llmBatchJobs.enrichStatus.startedAt) }) }}
        </p>
        <p v-else-if="llmBatchJobs.enrichStatus.finishedAt" class="text-muted-foreground">
          {{ $t('settings.sources.enrichStatusLastRun', {
            at: formatBatchDate(llmBatchJobs.enrichStatus.finishedAt),
            archived: llmBatchJobs.enrichStatus.lastResult?.archived ?? 0,
            duration: Math.round((llmBatchJobs.enrichStatus.lastResult?.durationMs ?? 0) / 1000),
          }) }}
        </p>
        <ul v-if="crawlProgressByCountry.length" class="space-y-3 rounded-md border p-3">
          <li v-for="row in crawlProgressByCountry" :key="row.code" class="space-y-1">
            <div class="flex items-baseline justify-between gap-2 text-xs">
              <span class="font-medium text-foreground">
                {{ row.label }}
                <span class="ml-1 font-mono uppercase text-muted-foreground">{{ row.code }}</span>
              </span>
              <span class="text-muted-foreground">
                {{ $t('settings.sources.crawlCountryRegions', { done: row.regionsDone, total: row.regionsTotal }) }}
              </span>
            </div>
            <Progress :model-value="row.percent" />
            <p class="text-xs text-muted-foreground">
              {{ $t('settings.sources.crawlCountryListings', { done: row.archivedDone, total: row.archivedTotal }) }}
            </p>
          </li>
        </ul>
        <p v-if="llmBatchJobs.enrichStatus.lastError" class="text-destructive">
          {{ $t('settings.sources.enrichStatusLastError', { message: llmBatchJobs.enrichStatus.lastError }) }}
        </p>
        <p v-if="llmBatchJobs.enrichStatus.lastWarning" class="text-amber-600 dark:text-amber-400">
          {{ llmBatchJobs.enrichStatus.lastWarning }}
        </p>
      </div>

      <div v-if="llmBatchJobs?.reprocessStatus" class="text-sm space-y-1">
        <p v-if="llmBatchJobs.reprocessStatus.status === 'running'">
          {{ $t('settings.sources.llmStatusRunning', { at: formatBatchDate(llmBatchJobs.reprocessStatus.startedAt) }) }}
        </p>
        <p v-else-if="llmBatchJobs.reprocessStatus.finishedAt" class="text-muted-foreground">
          {{ $t('settings.sources.llmStatusLastRun', {
            at: formatBatchDate(llmBatchJobs.reprocessStatus.finishedAt),
            processed: llmBatchJobs.reprocessStatus.lastResult?.processed ?? 0,
            llmCalls: llmBatchJobs.reprocessStatus.lastResult?.llmCalls ?? 0,
            duration: Math.round((llmBatchJobs.reprocessStatus.lastResult?.durationMs ?? 0) / 1000),
          }) }}
        </p>
        <ul v-if="llmProgressByCountry.length" class="space-y-3 rounded-md border p-3">
          <li v-for="row in llmProgressByCountry" :key="row.code" class="space-y-1">
            <div class="flex items-baseline justify-between gap-2 text-xs">
              <span class="font-medium text-foreground">
                {{ row.label }}
                <span class="ml-1 font-mono uppercase text-muted-foreground">{{ row.code }}</span>
              </span>
              <span class="text-muted-foreground">{{ row.done }}/{{ row.total }}</span>
            </div>
            <Progress :model-value="row.percent" />
            <p class="text-xs text-muted-foreground">
              {{ $t('settings.sources.llmCountryCaption', { llmCalls: row.llmCalls, llmErrors: row.llmErrors }) }}
            </p>
          </li>
        </ul>
        <p v-if="llmBatchJobs.reprocessStatus.lastWarning" class="text-amber-600 dark:text-amber-400">
          {{ $t('settings.sources.llmStatusLastWarning', { message: llmBatchJobs.reprocessStatus.lastWarning }) }}
        </p>
        <p v-if="llmBatchJobs.reprocessStatus.lastError" class="text-destructive">
          {{ $t('settings.sources.llmStatusLastError', { message: llmBatchJobs.reprocessStatus.lastError }) }}
        </p>
        <p v-if="llmBatchJobs.reprocessStatus.lastResult?.llmErrors" class="text-destructive">
          {{ $t('settings.sources.llmStatusLlmErrors', { count: llmBatchJobs.reprocessStatus.lastResult.llmErrors }) }}
        </p>
        <p v-if="llmBatchJobs.reprocessStatus.lastLlmError" class="text-destructive">
          {{ $t('settings.sources.llmStatusLastLlmError', { message: llmBatchJobs.reprocessStatus.lastLlmError }) }}
        </p>
      </div>

      <div v-if="llmBatchJobs?.offloadImagesStatus?.finishedAt" class="text-sm space-y-1">
        <p class="text-muted-foreground">
          {{ $t('settings.sources.offloadStatusLastRun', {
            at: formatBatchDate(llmBatchJobs.offloadImagesStatus.finishedAt),
            removed: llmBatchJobs.offloadImagesStatus.lastResult?.removed ?? 0,
            freedMb: Math.round((llmBatchJobs.offloadImagesStatus.lastResult?.freedBytes ?? 0) / 1024 / 1024),
          }) }}
        </p>
        <p v-if="llmBatchJobs.offloadImagesStatus.lastWarning" role="alert" class="text-amber-600 dark:text-amber-400">
          {{ llmBatchJobs.offloadImagesStatus.lastWarning }}
        </p>
        <p v-if="llmBatchJobs.offloadImagesStatus.lastError" role="alert" class="text-destructive">
          {{ $t('settings.sources.offloadStatusLastError', { message: llmBatchJobs.offloadImagesStatus.lastError }) }}
        </p>
      </div>

      <div v-if="llmBatchJobs?.externalEnrichmentStatus" class="text-sm space-y-1">
        <p v-if="llmBatchJobs.externalEnrichmentStatus.status === 'running'">
          {{ $t('settings.sources.externalStatusRunning', { at: formatBatchDate(llmBatchJobs.externalEnrichmentStatus.startedAt) }) }}
        </p>
        <p v-else-if="llmBatchJobs.externalEnrichmentStatus.finishedAt" class="text-muted-foreground">
          {{ $t('settings.sources.externalStatusLastRun', {
            at: formatBatchDate(llmBatchJobs.externalEnrichmentStatus.finishedAt),
            processed: llmBatchJobs.externalEnrichmentStatus.lastResult?.processed ?? 0,
            written: llmBatchJobs.externalEnrichmentStatus.lastResult?.written ?? 0,
            duration: Math.round((llmBatchJobs.externalEnrichmentStatus.lastResult?.durationMs ?? 0) / 1000),
          }) }}
        </p>
        <p v-if="llmBatchJobs.externalEnrichmentStatus.lastWarning" role="alert" class="text-amber-600 dark:text-amber-400">
          {{ llmBatchJobs.externalEnrichmentStatus.lastWarning }}
        </p>
        <p v-if="llmBatchJobs.externalEnrichmentStatus.lastError" role="alert" class="text-destructive">
          {{ $t('settings.sources.externalStatusLastError', { message: llmBatchJobs.externalEnrichmentStatus.lastError }) }}
        </p>
      </div>

      <form class="space-y-3" @submit.prevent="saveCountrySources">
        <label class="flex items-start gap-2 rounded-md border bg-muted/20 p-3 text-sm">
          <Checkbox v-model="forceCountryExtraction" class="mt-0.5" :disabled="countryEnrichPending !== null" />
          <span class="space-y-1">
            <span class="block font-medium">{{ $t('settings.sources.forceExtraction') }}</span>
            <span class="block text-xs text-muted-foreground">{{ $t('settings.sources.forceExtractionHelp') }}</span>
          </span>
        </label>

        <div class="max-h-80 overflow-y-auto rounded-md border divide-y">
          <div v-for="source in countrySources" :key="source.code" class="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/50">
            <Checkbox
              class="mt-0.5"
              :model-value="source.enabled"
              :disabled="countrySourcesPending"
              @update:model-value="toggleCountrySource(source.code)"
            />
            <button type="button" class="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-60" :disabled="countrySourcesPending" @click="toggleCountrySource(source.code)">
              <span class="block text-sm font-medium">
                {{ countryLabel(source.code, source.name) }}
                <span class="ml-1 font-mono text-xs uppercase text-muted-foreground">{{ source.code }}</span>
              </span>
              <span class="block text-xs text-muted-foreground">
                {{ source.platforms.map((platform) => platform.name).join(', ') }}
              </span>
            </button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              class="shrink-0"
              :title="$t('settings.sources.enrichTitle')"
              :disabled="!source.enabled || countrySourcesPending || countryEnrichPending !== null"
              @click="enrichCountrySource(source)"
            >
              <Loader2 v-if="countryEnrichPending === source.code" class="h-4 w-4 animate-spin" />
              <RefreshCw v-else class="h-4 w-4" />
              {{ countryEnrichPending === source.code ? $t('settings.sources.enriching') : $t('settings.sources.enrich') }}
            </Button>
          </div>
        </div>

        <p class="text-xs text-muted-foreground">
          {{ $t('settings.sources.enabledCount', {
            enabled: enabledCountrySourceCount,
            total: countrySources.length,
          }) }}
        </p>

        <Button type="submit" :disabled="countrySourcesPending || !countrySourcesLoaded">
          {{ countrySourcesPending ? $t('settings.sources.saving') : $t('settings.sources.save') }}
        </Button>
      </form>
    </CardContent>
  </Card>
</template>
