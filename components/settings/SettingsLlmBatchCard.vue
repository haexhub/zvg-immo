<script setup lang="ts">
import { RefreshCw } from 'lucide-vue-next'
import { useSettingsTaskOverview } from '~/composables/settings/useSettingsTaskOverview'

const {
  llmBatchJobs,
  llmBatchJobsPending,
  llmBatchJobsError,
  llmBatchBacklog,
  formatBatchDate,
  loadLlmBatchJobs,
} = useSettingsTaskOverview()

onMounted(loadLlmBatchJobs)
</script>

<template>
  <Card>
    <CardHeader>
      <div class="flex items-center justify-between gap-3">
        <CardTitle>{{ $t('settings.llmBatch.title') }}</CardTitle>
        <Button type="button" variant="outline" size="sm" :disabled="llmBatchJobsPending" @click="loadLlmBatchJobs">
          <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': llmBatchJobsPending }" />
          {{ $t('settings.llmBatch.refresh') }}
        </Button>
      </div>
    </CardHeader>
    <CardContent class="space-y-4">
      <p class="text-sm text-muted-foreground">
        {{ $t('settings.llmBatch.description') }}
      </p>
      <p v-if="llmBatchJobsError" class="text-sm text-destructive">{{ llmBatchJobsError }}</p>

      <div v-if="llmBatchJobs?.reprocessStatus" class="text-sm space-y-1">
        <p v-if="llmBatchJobs.reprocessStatus.status === 'running'">
          {{ $t('settings.llmBatch.reprocessRunning', { at: formatBatchDate(llmBatchJobs.reprocessStatus.startedAt) }) }}
        </p>
        <p v-else-if="llmBatchJobs.reprocessStatus.finishedAt" class="text-muted-foreground">
          {{ $t('settings.llmBatch.reprocessLastRun', {
            at: formatBatchDate(llmBatchJobs.reprocessStatus.finishedAt),
            processed: llmBatchJobs.reprocessStatus.lastResult?.processed ?? 0,
            llmCalls: llmBatchJobs.reprocessStatus.lastResult?.llmCalls ?? 0,
            duration: Math.round((llmBatchJobs.reprocessStatus.lastResult?.durationMs ?? 0) / 1000),
          }) }}
        </p>
        <SettingsMessageDetails
          v-if="llmBatchJobs.reprocessStatus.lastError"
          :text="$t('settings.llmBatch.reprocessLastError', { message: llmBatchJobs.reprocessStatus.lastError })"
          variant="error"
        />
        <SettingsMessageDetails
          v-if="llmBatchJobs.reprocessStatus.lastWarning"
          :text="$t('settings.llmBatch.reprocessLastWarning', { message: llmBatchJobs.reprocessStatus.lastWarning })"
          variant="warning"
        />
        <p v-if="llmBatchJobs.reprocessStatus.lastResult?.llmErrors" class="text-destructive">
          {{ $t('settings.llmBatch.reprocessLlmErrors', { count: llmBatchJobs.reprocessStatus.lastResult.llmErrors }) }}
        </p>
        <SettingsMessageDetails
          v-if="llmBatchJobs.reprocessStatus.lastLlmError"
          :text="$t('settings.llmBatch.reprocessLastLlmError', { message: llmBatchJobs.reprocessStatus.lastLlmError })"
          variant="error"
        />
      </div>

      <div class="grid grid-cols-2 gap-3 text-sm">
        <div class="border rounded-md p-3">
          <div class="text-xs text-muted-foreground">{{ $t('settings.llmBatch.totalJobs') }}</div>
          <div class="text-xl font-semibold tabular-nums">{{ llmBatchJobs?.totalJobs ?? 0 }}</div>
        </div>
        <div class="border rounded-md p-3">
          <div class="text-xs text-muted-foreground">{{ $t('settings.llmBatch.totalRequests') }}</div>
          <div class="text-xl font-semibold tabular-nums">{{ llmBatchJobs?.totalRequests ?? 0 }}</div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div class="border rounded-md p-3">
          <div class="text-xs text-muted-foreground">{{ $t('settings.llmBatch.readyRequests') }}</div>
          <div class="text-xl font-semibold tabular-nums">{{ llmBatchBacklog.readyRequests }}</div>
        </div>
        <div class="border rounded-md p-3">
          <div class="text-xs text-muted-foreground">{{ $t('settings.llmBatch.lowConfidenceRules') }}</div>
          <div class="text-xl font-semibold tabular-nums">{{ llmBatchBacklog.lowConfidenceRules }}</div>
        </div>
        <div class="border rounded-md p-3">
          <div class="text-xs text-muted-foreground">{{ $t('settings.llmBatch.missingLlmFields') }}</div>
          <div class="text-xl font-semibold tabular-nums">{{ llmBatchBacklog.missingLlmFields }}</div>
        </div>
        <div class="border rounded-md p-3">
          <div class="text-xs text-muted-foreground">{{ $t('settings.llmBatch.orphanedBatchMarkers') }}</div>
          <div class="text-xl font-semibold tabular-nums">{{ llmBatchBacklog.orphanedBatchMarkers }}</div>
        </div>
      </div>

      <p v-if="llmBatchBacklog.failedLimit > 0" class="text-sm text-muted-foreground">
        {{ $t('settings.llmBatch.failedLimit', { count: llmBatchBacklog.failedLimit }) }}
      </p>

      <div v-if="llmBatchBacklog.sampleRequestKeys.length" class="space-y-2">
        <div class="text-sm font-medium">{{ $t('settings.llmBatch.readySample') }}</div>
        <div class="max-h-32 overflow-auto rounded border bg-muted/30 p-2">
          <div v-for="key in llmBatchBacklog.sampleRequestKeys" :key="`ready:${key}`" class="font-mono text-xs leading-6">
            {{ key }}
          </div>
        </div>
      </div>

      <div v-if="llmBatchBacklog.orphanedRequestKeys.length" class="space-y-2">
        <div class="text-sm font-medium">{{ $t('settings.llmBatch.orphanedSample') }}</div>
        <div class="max-h-32 overflow-auto rounded border bg-muted/30 p-2">
          <div v-for="key in llmBatchBacklog.orphanedRequestKeys" :key="`orphaned:${key}`" class="font-mono text-xs leading-6">
            {{ key }}
          </div>
        </div>
      </div>

      <p v-if="!llmBatchJobsPending && (!llmBatchJobs || llmBatchJobs.jobs.length === 0)" class="text-sm text-muted-foreground">
        {{ $t('settings.llmBatch.empty') }}
      </p>

      <div v-if="llmBatchJobs?.jobs.length" class="space-y-3">
        <div class="text-sm font-medium">{{ $t('settings.llmBatch.openHeading') }}</div>
      </div>
      <div v-for="job in llmBatchJobs?.jobs ?? []" :key="job.jobName" class="border rounded-md p-3 space-y-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="font-mono text-xs break-all">{{ job.jobName }}</div>
            <div class="mt-1 flex flex-wrap gap-2">
              <Badge variant="secondary">{{ job.provider }}</Badge>
              <Badge variant="outline">{{ $t(`settings.llmBatch.source.${job.source}`) }}</Badge>
              <Badge variant="outline">{{ $t(`settings.llmBatch.status.${job.status}`) }}</Badge>
            </div>
          </div>
          <div class="text-right text-sm">
            <div class="font-semibold tabular-nums">
              {{ $t('settings.llmBatch.pendingOfTotal', { pending: job.pendingCount, total: job.itemCount }) }}
            </div>
            <div class="text-xs text-muted-foreground">
              {{ $t('settings.llmBatch.submittedAt', { at: formatBatchDate(job.submittedAt) }) }}
            </div>
          </div>
        </div>

        <div v-if="job.requestKeys.length" class="max-h-40 overflow-auto rounded border bg-muted/30 p-2">
          <div v-for="key in job.requestKeys" :key="`${job.jobName}:${key}`" class="font-mono text-xs leading-6">
            {{ key }}
          </div>
        </div>
      </div>

      <div v-if="llmBatchJobs?.recentJobs.length" class="space-y-3">
        <div class="text-sm font-medium">{{ $t('settings.llmBatch.historyHeading') }}</div>
        <div v-for="job in llmBatchJobs.recentJobs" :key="`recent:${job.jobName}`" class="border rounded-md p-3 space-y-2">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="font-mono text-xs break-all">{{ job.jobName }}</div>
              <div class="mt-1 flex flex-wrap gap-2">
                <Badge variant="secondary">{{ job.provider }}</Badge>
                <Badge variant="outline">{{ $t(`settings.llmBatch.source.${job.source}`) }}</Badge>
                <Badge variant="outline">{{ $t(`settings.llmBatch.status.${job.status}`) }}</Badge>
              </div>
            </div>
            <div class="text-right text-sm">
              <div class="font-semibold tabular-nums">
                {{ $t('settings.llmBatch.itemsTotal', { total: job.itemCount }) }}
              </div>
              <div class="text-xs text-muted-foreground">
                {{ $t('settings.llmBatch.updatedAt', { at: formatBatchDate(job.updatedAt) }) }}
              </div>
            </div>
          </div>
          <SettingsMessageDetails v-if="job.errorMessage" :text="job.errorMessage" variant="error" />
          <div v-if="job.requestKeys.length" class="max-h-28 overflow-auto rounded border bg-muted/30 p-2">
            <div v-for="key in job.requestKeys" :key="`recent:${job.jobName}:${key}`" class="font-mono text-xs leading-6">
              {{ key }}
            </div>
          </div>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
