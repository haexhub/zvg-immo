import type { LlmProvider } from '~/server/utils/app-settings'
import { useSettingsError } from './useSettingsError'

export interface LlmBatchJobOverviewItem {
  provider: LlmProvider
  jobName: string
  source: 'reprocess' | 'translation'
  status: string
  itemCount: number
  pendingCount: number
  requestKeys: string[]
  submittedAt: string
  updatedAt: string
  errorMessage?: string | null
}

interface LlmBatchCapability {
  ok: boolean
  source: 'config' | 'attempt'
  message?: string | null
  checkedAt: string
}

interface TaskRunStatus {
  status: 'idle' | 'running' | 'done' | 'failed'
  startedAt: string | null
  finishedAt: string | null
  lastResult: Record<string, any> | null
  lastError: string | null
  lastWarning?: string | null
  lastLlmError?: string | null
  progress?: Record<string, number | string | null>
  progressByCountry?: Record<string, Record<string, number | string | null>> | null
}

export interface LlmBatchJobsOverview {
  totalJobs: number
  totalRequests: number
  jobs: LlmBatchJobOverviewItem[]
  recentJobs: LlmBatchJobOverviewItem[]
  backlog: {
    readyRequests: number
    lowConfidenceRules: number
    missingLlmFields: number
    orphanedBatchMarkers: number
    failedLimit: number
    sampleRequestKeys: string[]
    orphanedRequestKeys: string[]
  }
  capabilities: Partial<Record<LlmProvider, LlmBatchCapability>>
  enrichStatus: TaskRunStatus
  reprocessStatus: TaskRunStatus
  externalEnrichmentStatus: TaskRunStatus
  offloadImagesStatus?: TaskRunStatus
}

let progressPollTimer: ReturnType<typeof setInterval> | null = null

function formatBatchDate(iso: string | null): string {
  if (!iso) return '-'
  const date = new Date(iso)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : iso
}

export function useSettingsTaskOverview() {
  const { t } = useI18n()
  const { normalizeSettingsError } = useSettingsError()

  const llmBatchJobs = useState<LlmBatchJobsOverview | null>('settings-llm-batch-jobs', () => null)
  const llmBatchJobsPending = useState('settings-llm-batch-jobs-pending', () => false)
  const llmBatchJobsError = useState<string | null>('settings-llm-batch-jobs-error', () => null)

  function anyTrackedTaskRunning(): boolean {
    const overview = llmBatchJobs.value
    if (!overview) return false
    return overview.enrichStatus.status === 'running' ||
      overview.reprocessStatus.status === 'running' ||
      overview.externalEnrichmentStatus.status === 'running' ||
      overview.offloadImagesStatus?.status === 'running'
  }

  const llmBatchBacklog = computed(() => llmBatchJobs.value?.backlog ?? {
    readyRequests: 0,
    lowConfidenceRules: 0,
    missingLlmFields: 0,
    orphanedBatchMarkers: 0,
    failedLimit: 0,
    sampleRequestKeys: [],
    orphanedRequestKeys: [],
  })

  async function loadLlmBatchJobs(): Promise<void> {
    llmBatchJobsPending.value = true
    llmBatchJobsError.value = null
    try {
      llmBatchJobs.value = await $fetch<LlmBatchJobsOverview>('/api/settings/llm-batch-jobs', { cache: 'no-store' })
      if (anyTrackedTaskRunning()) startProgressPolling()
    } catch (err) {
      llmBatchJobsError.value = normalizeSettingsError(err, t('settings.llmBatch.loadError'))
    } finally {
      llmBatchJobsPending.value = false
    }
  }

  function startProgressPolling(): void {
    if (progressPollTimer) return
    progressPollTimer = setInterval(async () => {
      await loadLlmBatchJobs()
      if (!anyTrackedTaskRunning()) stopProgressPolling()
    }, 3000)
  }

  function stopProgressPolling(): void {
    if (progressPollTimer) {
      clearInterval(progressPollTimer)
      progressPollTimer = null
    }
  }

  return {
    llmBatchJobs,
    llmBatchJobsPending,
    llmBatchJobsError,
    llmBatchBacklog,
    formatBatchDate,
    loadLlmBatchJobs,
    startProgressPolling,
    stopProgressPolling,
    anyTrackedTaskRunning,
  }
}
