<script setup lang="ts">
import { Loader2, RefreshCw } from 'lucide-vue-next'
import { useSettingsError } from '~/composables/settings/useSettingsError'
import { useSettingsTaskOverview } from '~/composables/settings/useSettingsTaskOverview'

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

const { t } = useI18n()
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
  await Promise.all([loadExternalDataSources(), loadLlmBatchJobs()])
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
          <RefreshCw v-else class="h-4 w-4" />
          {{ enrichmentTriggerPending ? $t('settings.externalData.refreshing') : $t('settings.externalData.refreshNow') }}
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">{{ $t('settings.externalData.description') }}</p>
      <p v-if="externalDataSourcesError" class="text-sm text-destructive">{{ externalDataSourcesError }}</p>
      <p v-if="enrichmentTriggerError" class="text-sm text-destructive">{{ enrichmentTriggerError }}</p>

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
        <p v-if="llmBatchJobs.externalEnrichmentStatus.lastError" class="text-sm text-destructive">
          {{ $t('settings.sources.externalStatusLastError', { message: llmBatchJobs.externalEnrichmentStatus.lastError }) }}
        </p>
      </div>

      <div v-for="source in externalDataSources" :key="source.id" class="space-y-3 rounded-md border p-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm font-medium">{{ source.label }}</p>
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
      </div>
    </CardContent>
  </Card>
</template>
