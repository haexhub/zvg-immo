<script setup lang="ts">
import { Loader2, Play } from 'lucide-vue-next'
import { useSettingsError } from '~/composables/settings/useSettingsError'
import { useSettingsTaskOverview } from '~/composables/settings/useSettingsTaskOverview'

interface CacheImportSourceConfig {
  endpoint: string
  requiresCsvPath?: boolean
  // Copernicus EFFIS's WFS dataset is two orders of magnitude bigger than the
  // other two (100k+ features, ~100 paginated requests) — its import runs
  // detached (POST returns {started:true} immediately) instead of
  // sync/awaited, same "detached" contract as e.g. reprocess/geo-metrics.
  // Progress/result surface via llmBatchJobs.copernicusEffisImportStatus.
  detached?: boolean
}

// Only these three configurable sources are backed by an out-of-band cache
// file (server/tasks/import-*-cache.ts) instead of a live, on-demand fetch —
// without this button an admin who fills in the config fields above has no
// way to actually populate that cache themselves; it only refills via its
// monthly cron (fr-dvf has no cron at all, since the source CSV is a manual
// download). See docs/plans/2026-07-26-eu-market-risk-data-sources-plan.md
// for the incident this gap already caused once.
const CACHE_IMPORT_SOURCES: Record<string, CacheImportSourceConfig> = {
  'eu-flood-risk-areas': { endpoint: '/api/settings/external-data/eu-flood-risk-cache' },
  'copernicus-effis': { endpoint: '/api/settings/external-data/copernicus-effis-cache', detached: true },
  'fr-dvf-geolocated': { endpoint: '/api/settings/external-data/fr-dvf-cache', requiresCsvPath: true },
}

interface ExternalDataSourceField {
  key: string
  type: 'url' | 'path' | 'number'
  envVar: string
  required: boolean
  storedValue: string | number | null
  effectiveValue: string | number
}
interface ExternalDataSourceSetting {
  id: string
  label: string
  sourceUrl: string
  licenseNote: string
  isConfigured: boolean
  fields: ExternalDataSourceField[]
}

interface ExternalDataCoverageCountryRow {
  country: string
  total: number
  covered: number
}
interface ExternalDataSourceCoverage {
  id: string
  total: number
  covered: number
  byCountry: ExternalDataCoverageCountryRow[]
}

const { t, te } = useI18n()
const countryLabel = useCountryLabel()
const { normalizeSettingsError } = useSettingsError()
const { llmBatchJobs, formatBatchDate, loadLlmBatchJobs, startProgressPolling } = useSettingsTaskOverview()

const externalDataSources = ref<ExternalDataSourceSetting[]>([])
const externalDataSourcesLoaded = ref(false)
const externalDataSourcesError = ref<string | null>(null)
const externalDataSourcePending = ref<string | null>(null)
const externalDataSourceSaved = ref<string | null>(null)
const externalDataFieldDrafts = reactive<Record<string, string>>({})
const enrichmentTriggerPending = ref(false)
const enrichmentTriggerError = ref<string | null>(null)

const coverage = ref<ExternalDataSourceCoverage[]>([])
const coverageError = ref<string | null>(null)

function percentOf(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
}

function coverageFor(sourceId: string): ExternalDataSourceCoverage | null {
  return coverage.value.find((entry) => entry.id === sourceId) ?? null
}

// external-enrichment reports numeric progress (unlike the detached
// reprocess/enrich tasks' own cards, this one has no other way to show that
// a full unscoped run is moving — it walks every auction sequentially and
// paces every Open-Meteo call, so a run over the whole DB can take a long
// time with nothing else to show for it in between.
const enrichmentProgress = computed(() => {
  const progress = llmBatchJobs.value?.externalEnrichmentStatus?.progress
  if (!progress) return null
  const total = Number(progress.total ?? 0)
  const done = Number(progress.processed ?? 0) + Number(progress.skippedMissingCoordinates ?? 0)
  return { total, done, percent: percentOf(done, total) }
})

const copernicusEffisImportStatus = computed(() => llmBatchJobs.value?.copernicusEffisImportStatus ?? null)

async function loadCoverage(): Promise<void> {
  try {
    const res = await $fetch<{ sources: ExternalDataSourceCoverage[] }>('/api/settings/external-data/coverage')
    coverage.value = res.sources
    coverageError.value = null
  } catch (err) {
    coverageError.value = normalizeSettingsError(err, t('settings.externalData.coverage.loadError'))
  }
}

async function triggerEnrichment(): Promise<void> {
  enrichmentTriggerPending.value = true
  enrichmentTriggerError.value = null
  try {
    await $fetch('/api/settings/external-data/enrichment', { method: 'POST' })
    await loadLlmBatchJobs()
    startProgressPolling()
  } catch (err) {
    enrichmentTriggerError.value = normalizeSettingsError(err, t('settings.externalData.triggerError'))
  } finally {
    enrichmentTriggerPending.value = false
  }
}

function externalDataDraftKey(sourceId: string, fieldKey: string): string {
  return `${sourceId}:${fieldKey}`
}

const cacheImportPending = ref<string | null>(null)
const cacheImportError = reactive<Record<string, string | null>>({})
const cacheImportResult = reactive<Record<string, string | null>>({})
const csvPathDrafts = reactive<Record<string, string>>({})

function cacheImportConfig(sourceId: string): CacheImportSourceConfig | null {
  return CACHE_IMPORT_SOURCES[sourceId] ?? null
}

async function triggerCacheImport(sourceId: string): Promise<void> {
  const config = cacheImportConfig(sourceId)
  if (!config || cacheImportPending.value) return
  const csvPath = csvPathDrafts[sourceId]?.trim() ?? ''
  if (config.requiresCsvPath && !csvPath) {
    cacheImportError[sourceId] = t('settings.externalData.cacheImport.csvPathRequired')
    return
  }
  cacheImportPending.value = sourceId
  cacheImportError[sourceId] = null
  cacheImportResult[sourceId] = null
  try {
    const body = config.requiresCsvPath ? { csvPath } : {}
    if (config.detached) {
      await $fetch(config.endpoint, { method: 'POST', body })
      cacheImportResult[sourceId] = t('settings.externalData.cacheImport.started')
      await loadLlmBatchJobs()
      startProgressPolling()
      return
    }
    const summary = await $fetch<{ normalized?: number; generatedAt?: string; skipped?: string }>(
      config.endpoint,
      { method: 'POST', body },
    )
    // import-eu-flood-risk-cache's task guard returns `{ skipped }` instead of
    // importing when the source has no cache path configured anywhere. Without
    // this branch that no-op renders as a successful import of `undefined`
    // records.
    if (typeof summary.normalized !== 'number') {
      cacheImportError[sourceId] = t('settings.externalData.cacheImport.skipped')
      return
    }
    cacheImportResult[sourceId] = t('settings.externalData.cacheImport.done', {
      normalized: summary.normalized,
      at: formatBatchDate(summary.generatedAt ?? null),
    })
  } catch (err) {
    cacheImportError[sourceId] = normalizeSettingsError(err, t('settings.externalData.cacheImport.error'))
  } finally {
    cacheImportPending.value = null
  }
}

function sourceUsageHint(sourceId: string): string | null {
  const key = `settings.externalData.usageHints.${sourceId}`
  return te(key) ? t(key) : null
}

async function loadExternalDataSources(): Promise<void> {
  try {
    const res = await $fetch<{ sources: ExternalDataSourceSetting[] }>('/api/settings/external-data/sources')
    externalDataSources.value = res.sources
    for (const source of res.sources) {
      for (const field of source.fields) {
        externalDataFieldDrafts[externalDataDraftKey(source.id, field.key)] = field.storedValue != null ? String(field.storedValue) : ''
      }
    }
    externalDataSourcesLoaded.value = true
    externalDataSourcesError.value = null
  } catch (err) {
    externalDataSourcesLoaded.value = false
    externalDataSourcesError.value = normalizeSettingsError(err, t('settings.externalData.loadError'))
  }
}

async function saveExternalDataSource(source: ExternalDataSourceSetting): Promise<void> {
  if (!externalDataSourcesLoaded.value) return
  externalDataSourcePending.value = source.id
  externalDataSourceSaved.value = null
  externalDataSourcesError.value = null
  try {
    const body: Record<string, string> = {}
    for (const field of source.fields) {
      body[field.key] = externalDataFieldDrafts[externalDataDraftKey(source.id, field.key)] ?? ''
    }
    await $fetch(`/api/settings/external-data/sources/${source.id}`, { method: 'PUT', body })
    await loadExternalDataSources()
    externalDataSourceSaved.value = source.id
  } catch (err) {
    externalDataSourcesError.value = normalizeSettingsError(err, t('settings.externalData.saveError'))
  } finally {
    externalDataSourcePending.value = null
  }
}

onMounted(async () => {
  await Promise.all([loadExternalDataSources(), loadLlmBatchJobs(), loadCoverage()])
})
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ $t('settings.externalData.title') }}</CardTitle>
      <CardAction>
        <Button
          type="button"
          variant="outline"
          size="sm"
          :disabled="enrichmentTriggerPending"
          @click="triggerEnrichment"
        >
          <Loader2 v-if="enrichmentTriggerPending" class="h-4 w-4 animate-spin" />
          <Play v-else class="h-4 w-4" />
          {{ enrichmentTriggerPending ? $t('settings.externalData.refreshing') : $t('settings.externalData.refreshNow') }}
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">{{ $t('settings.externalData.description') }}</p>
      <p v-if="externalDataSourcesError" class="text-sm text-destructive">{{ externalDataSourcesError }}</p>
      <p v-if="enrichmentTriggerError" class="text-sm text-destructive">{{ enrichmentTriggerError }}</p>
      <p v-if="coverageError" class="text-sm text-destructive">{{ coverageError }}</p>

      <div v-if="llmBatchJobs?.externalEnrichmentStatus" class="text-sm space-y-1">
        <template v-if="llmBatchJobs.externalEnrichmentStatus.status === 'running'">
          <p>
            {{ $t('settings.sources.externalStatusRunning', { at: formatBatchDate(llmBatchJobs.externalEnrichmentStatus.startedAt) }) }}
          </p>
          <template v-if="enrichmentProgress">
            <div class="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
              <span>{{ $t('settings.sources.externalStatusProgress', { done: enrichmentProgress.done, total: enrichmentProgress.total }) }}</span>
              <span>{{ enrichmentProgress.percent }}%</span>
            </div>
            <Progress :model-value="enrichmentProgress.percent" />
          </template>
        </template>
        <p v-else-if="llmBatchJobs.externalEnrichmentStatus.finishedAt" class="text-muted-foreground">
          {{ $t('settings.sources.externalStatusLastRun', {
            at: formatBatchDate(llmBatchJobs.externalEnrichmentStatus.finishedAt),
            processed: llmBatchJobs.externalEnrichmentStatus.lastResult?.processed ?? 0,
            written: llmBatchJobs.externalEnrichmentStatus.lastResult?.written ?? 0,
            duration: Math.round((llmBatchJobs.externalEnrichmentStatus.lastResult?.durationMs ?? 0) / 1000),
          }) }}
        </p>
        <p v-if="llmBatchJobs.externalEnrichmentStatus.lastError" class="text-sm text-destructive">
          {{ $t('settings.sources.externalStatusLastError', { message: llmBatchJobs.externalEnrichmentStatus.lastError }) }}
        </p>
      </div>

      <div v-for="source in externalDataSources" :key="source.id" class="space-y-3 rounded-md border p-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm font-medium">{{ source.label }}</p>
            <p v-if="sourceUsageHint(source.id)" class="text-xs">{{ sourceUsageHint(source.id) }}</p>
            <p class="text-xs text-muted-foreground">{{ source.licenseNote }}</p>
            <a :href="source.sourceUrl" target="_blank" rel="noopener" class="text-xs underline underline-offset-2 hover:text-foreground">
              {{ source.sourceUrl }}
            </a>
          </div>
          <Badge
            variant="outline"
            :class="source.isConfigured
              ? 'shrink-0 text-emerald-600 dark:text-emerald-500 border-emerald-600/40'
              : 'shrink-0 text-muted-foreground'"
          >
            {{ source.isConfigured ? $t('settings.externalData.configured') : $t('settings.externalData.notConfigured') }}
          </Badge>
        </div>

        <div v-if="coverageFor(source.id)" class="space-y-2 rounded-md bg-muted/20 p-2">
          <div class="flex items-baseline justify-between gap-2 text-xs">
            <span class="font-medium text-foreground">{{ $t('settings.externalData.coverage.title') }}</span>
            <span class="text-muted-foreground">
              {{ $t('settings.externalData.coverage.summary', {
                covered: coverageFor(source.id)!.covered,
                total: coverageFor(source.id)!.total,
                percent: percentOf(coverageFor(source.id)!.covered, coverageFor(source.id)!.total),
              }) }}
            </span>
          </div>
          <Progress :model-value="percentOf(coverageFor(source.id)!.covered, coverageFor(source.id)!.total)" />
          <p v-if="coverageFor(source.id)!.byCountry.length === 0" class="text-xs text-muted-foreground">
            {{ $t('settings.externalData.coverage.empty') }}
          </p>
          <ul v-else class="max-h-40 space-y-2 overflow-y-auto pr-1">
            <li v-for="row in coverageFor(source.id)!.byCountry" :key="row.country" class="space-y-1">
              <div class="flex items-baseline justify-between gap-2 text-xs">
                <span class="text-foreground">
                  {{ countryLabel(row.country) }}
                  <span class="ml-1 font-mono uppercase text-muted-foreground">{{ row.country }}</span>
                </span>
                <span class="text-muted-foreground">{{ row.covered }}/{{ row.total }}</span>
              </div>
              <Progress :model-value="percentOf(row.covered, row.total)" class="h-1.5" />
            </li>
          </ul>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div v-for="field in source.fields" :key="field.key" class="min-w-0 space-y-1">
            <label class="block break-words text-xs font-medium text-muted-foreground">{{ field.envVar }}</label>
            <Input
              v-model="externalDataFieldDrafts[`${source.id}:${field.key}`]"
              :type="field.type === 'number' ? 'number' : 'text'"
              :placeholder="String(field.effectiveValue)"
            />
          </div>
        </div>

        <div class="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            :disabled="externalDataSourcePending === source.id || !externalDataSourcesLoaded"
            @click="saveExternalDataSource(source)"
          >
            {{ externalDataSourcePending === source.id ? $t('settings.externalData.saving') : $t('settings.externalData.save') }}
          </Button>
          <span v-if="externalDataSourceSaved === source.id" class="text-xs text-emerald-600 dark:text-emerald-500">
            {{ $t('settings.externalData.saved') }}
          </span>
        </div>

        <div v-if="cacheImportConfig(source.id)" class="flex flex-wrap items-center gap-2 border-t pt-3">
          <Input
            v-if="cacheImportConfig(source.id)?.requiresCsvPath"
            v-model="csvPathDrafts[source.id]"
            :aria-label="$t('settings.externalData.cacheImport.csvPathPlaceholder')"
            :placeholder="$t('settings.externalData.cacheImport.csvPathPlaceholder')"
            class="max-w-xs"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            :disabled="cacheImportPending === source.id"
            @click="triggerCacheImport(source.id)"
          >
            <Loader2 v-if="cacheImportPending === source.id" class="h-4 w-4 animate-spin" />
            <Play v-else class="h-4 w-4" />
            {{ cacheImportPending === source.id ? $t('settings.externalData.cacheImport.importing') : $t('settings.externalData.cacheImport.import') }}
          </Button>
          <span v-if="cacheImportResult[source.id]" class="text-xs text-emerald-600 dark:text-emerald-500">{{ cacheImportResult[source.id] }}</span>
          <span v-if="cacheImportError[source.id]" class="text-xs text-destructive">{{ cacheImportError[source.id] }}</span>
        </div>

        <div v-if="source.id === 'copernicus-effis' && copernicusEffisImportStatus" class="text-xs space-y-1">
          <p v-if="copernicusEffisImportStatus.status === 'running'" class="text-muted-foreground">
            {{ $t('settings.sources.copernicusEffisStatusRunning', { at: formatBatchDate(copernicusEffisImportStatus.startedAt) }) }}
          </p>
          <p v-else-if="copernicusEffisImportStatus.finishedAt" class="text-muted-foreground">
            {{ $t('settings.sources.copernicusEffisStatusLastRun', {
              at: formatBatchDate(copernicusEffisImportStatus.finishedAt),
              normalized: copernicusEffisImportStatus.lastResult?.normalized ?? 0,
              fetched: copernicusEffisImportStatus.lastResult?.fetched ?? 0,
              pages: copernicusEffisImportStatus.lastResult?.pages ?? 0,
            }) }}
          </p>
          <p v-if="copernicusEffisImportStatus.lastError" class="text-destructive">
            {{ $t('settings.sources.copernicusEffisStatusLastError', { message: copernicusEffisImportStatus.lastError }) }}
          </p>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
