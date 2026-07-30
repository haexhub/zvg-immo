<script setup lang="ts">
import { useSettingsError } from '~/composables/settings/useSettingsError'
import { useSettingsTaskOverview } from '~/composables/settings/useSettingsTaskOverview'

interface ReprocessResult {
  candidates: number
  processed: number
  skipped: number
  llmCalls: number
  llmErrors: number
  durationMs: number
  warning?: string
  lastLlmError?: string
}

const { t } = useI18n()
const { normalizeSettingsError } = useSettingsError()
const { loadLlmBatchJobs } = useSettingsTaskOverview()

const reprocessLimit = ref('10')
const reprocessCountry = ref('')
const reprocessBatch = ref(false)
const reprocessPending = ref(false)
const reprocessError = ref<string | null>(null)
const reprocessResult = ref<ReprocessResult | null>(null)

function parseReprocessLimit(raw: string): number | null {
  const value = Number(raw)
  return Number.isInteger(value) && value >= 1 && value <= 200 ? value : null
}

async function runReprocessTest(): Promise<void> {
  const limit = parseReprocessLimit(reprocessLimit.value)
  if (limit === null) {
    reprocessError.value = t('settings.reprocess.invalidLimit')
    return
  }
  reprocessPending.value = true
  reprocessError.value = null
  reprocessResult.value = null
  try {
    reprocessResult.value = await $fetch<ReprocessResult>('/api/settings/reprocess', {
      method: 'POST',
      body: {
        limit,
        country: reprocessCountry.value.trim() || undefined,
        batch: reprocessBatch.value || undefined,
      },
    })
    await loadLlmBatchJobs()
  } catch (err) {
    reprocessError.value = normalizeSettingsError(err, t('settings.reprocess.runError'))
  } finally {
    reprocessPending.value = false
  }
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ $t('settings.reprocess.title') }}</CardTitle>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">
        {{ $t('settings.reprocess.description') }}
      </p>

      <p v-if="reprocessError" class="text-sm text-destructive">{{ reprocessError }}</p>

      <form class="space-y-3" @submit.prevent="runReprocessTest">
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <Label>{{ $t('settings.reprocess.limitLabel') }}</Label>
            <Input v-model="reprocessLimit" type="number" min="1" max="200" step="1" />
          </div>
          <div class="space-y-1">
            <Label>{{ $t('settings.reprocess.countryLabel') }}</Label>
            <Input v-model="reprocessCountry" />
          </div>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <Checkbox v-model="reprocessBatch" />
          {{ $t('settings.reprocess.batchLabel') }}
        </label>
        <Button type="submit" :disabled="reprocessPending">
          {{ reprocessPending ? $t('settings.reprocess.running') : $t('settings.reprocess.run') }}
        </Button>
      </form>

      <dl v-if="reprocessResult" class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm border-t pt-3">
        <dt class="text-muted-foreground">{{ $t('settings.reprocess.candidates') }}</dt>
        <dd>{{ reprocessResult.candidates }}</dd>
        <dt class="text-muted-foreground">{{ $t('settings.reprocess.processed') }}</dt>
        <dd>{{ reprocessResult.processed }}</dd>
        <dt class="text-muted-foreground">{{ $t('settings.reprocess.skipped') }}</dt>
        <dd>{{ reprocessResult.skipped }}</dd>
        <dt class="text-muted-foreground">{{ $t('settings.reprocess.llmCalls') }}</dt>
        <dd>{{ reprocessResult.llmCalls }}</dd>
        <dt class="text-muted-foreground">{{ $t('settings.reprocess.llmErrors') }}</dt>
        <dd>{{ reprocessResult.llmErrors }}</dd>
      </dl>
      <p v-if="reprocessResult?.warning" class="text-sm text-amber-600 dark:text-amber-400">
        {{ $t('settings.reprocess.warning', { message: reprocessResult.warning }) }}
      </p>
      <p v-if="reprocessResult?.lastLlmError" class="text-sm text-destructive">
        {{ $t('settings.reprocess.lastLlmError', { message: reprocessResult.lastLlmError }) }}
      </p>
    </CardContent>
  </Card>
</template>
