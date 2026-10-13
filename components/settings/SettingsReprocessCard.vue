<script setup lang="ts">
import { useSettingsError } from '~/composables/settings/useSettingsError'
import { useSettingsTaskOverview } from '~/composables/settings/useSettingsTaskOverview'

const { t } = useI18n()
const { normalizeSettingsError } = useSettingsError()
const { llmBatchJobs, loadLlmBatchJobs, startProgressPolling } = useSettingsTaskOverview()

const reprocessLimit = ref('10')
const reprocessCountry = ref('')
const reprocessBatch = ref(false)
const reprocessPending = ref(false)
const reprocessError = ref<string | null>(null)
// The POST is detached, so the run's outcome arrives via the polled
// reprocessStatus. undefined = nothing triggered from this card yet;
// otherwise the finishedAt seen right before triggering — compared against
// server timestamps only, so client clock skew can't hide or fake a result.
// ponytail: a scheduled run finishing after ours would replace the shown
// summary; tagging runs with an id in task-runs.ts would make it exact.
const reprocessTriggeredAfter = ref<string | null | undefined>(undefined)
// Whether the shown result came from a batch submission — remembered at send
// time rather than read off the live checkbox, which the user can flip while
// the result is still on screen.
const reprocessResultWasBatch = ref(false)

const reprocessOutcome = computed(() => {
  const status = llmBatchJobs.value?.reprocessStatus
  if (reprocessTriggeredAfter.value === undefined || !status || status.status === 'running') return null
  if (!status.finishedAt || status.finishedAt === reprocessTriggeredAfter.value) return null
  return status
})
const reprocessAwaiting = computed(() => reprocessTriggeredAfter.value !== undefined && !reprocessOutcome.value)
const reprocessResult = computed(() => reprocessOutcome.value?.lastError ? null : reprocessOutcome.value?.lastResult ?? null)

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
  const batch = reprocessBatch.value
  try {
    await loadLlmBatchJobs()
    const previousFinishedAt = llmBatchJobs.value?.reprocessStatus.finishedAt ?? null
    await $fetch<{ started: true }>('/api/settings/reprocess', {
      method: 'POST',
      body: {
        limit,
        country: reprocessCountry.value.trim() || undefined,
        batch: batch || undefined,
      },
    })
    reprocessTriggeredAfter.value = previousFinishedAt
    reprocessResultWasBatch.value = batch
    await loadLlmBatchJobs()
    startProgressPolling()
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

      <p v-if="reprocessAwaiting" class="text-sm text-muted-foreground">{{ $t('settings.reprocess.started') }}</p>
      <SettingsMessageDetails
        v-if="reprocessOutcome?.lastError"
        :text="$t('settings.reprocess.failed', { message: reprocessOutcome.lastError })"
        variant="error"
      />

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
        <template v-if="!reprocessResultWasBatch">
          <dt class="text-muted-foreground">{{ $t('settings.reprocess.rulesFalsified') }}</dt>
          <dd>{{ reprocessResult.rulesFalsified }}</dd>
        </template>
      </dl>
      <SettingsMessageDetails
        v-if="reprocessResult && reprocessOutcome?.lastWarning"
        :text="$t('settings.reprocess.warning', { message: reprocessOutcome.lastWarning })"
        variant="warning"
      />
      <SettingsMessageDetails
        v-if="reprocessResult && reprocessOutcome?.lastLlmError"
        :text="$t('settings.reprocess.lastLlmError', { message: reprocessOutcome.lastLlmError })"
        variant="error"
      />
    </CardContent>
  </Card>
</template>
