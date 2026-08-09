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

// Consecutive recentJobs entries sharing the same status/source/provider/
// errorMessage get folded into one group — a crash-loop-style burst of
// identical failures (see reprocess-bootstrap.ts) otherwise renders as N
// near-duplicate cards instead of one "N× failed" summary.
export interface LlmBatchJobGroup {
  key: string
  status: string
  source: LlmBatchJobOverviewItem['source']
  provider: LlmBatchJobOverviewItem['provider']
  errorMessage: string | null
  totalItems: number
  // recentJobs is sorted newest-first, so the first job pushed into a group
  // is the newest and the last one pushed is the oldest — kept as their own
  // fields (rather than jobs[0]/jobs.at(-1)) so templates don't need
  // possibly-undefined array-index checks for a group that's never empty.
  newestJob: LlmBatchJobOverviewItem
  oldestJob: LlmBatchJobOverviewItem
  jobs: LlmBatchJobOverviewItem[]
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
  copernicusEffisImportStatus?: TaskRunStatus
}

let progressPollTimer: ReturnType<typeof setInterval> | null = null
// Module-scope, not useState: several settings cards call loadLlmBatchJobs()
// from their own onMounted, all firing in the same tick — without this,
// every /settings page load fired the same expensive endpoint 4x in
// parallel. Cleared once the in-flight request settles, so a later call
// still gets a fresh fetch.
let loadLlmBatchJobsInFlight: Promise<void> | null = null

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
      overview.offloadImagesStatus?.status === 'running' ||
      overview.copernicusEffisImportStatus?.status === 'running'
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

  const llmBatchRecentGroups = computed<LlmBatchJobGroup[]>(() => {
    const groups: LlmBatchJobGroup[] = []
    for (const job of llmBatchJobs.value?.recentJobs ?? []) {
      const last = groups[groups.length - 1]
      if (
        job.errorMessage &&
        last?.errorMessage === job.errorMessage &&
        last.status === job.status &&
        last.source === job.source &&
        last.provider === job.provider
      ) {
        last.jobs.push(job)
        last.totalItems += job.itemCount
        last.oldestJob = job
        continue
      }
      groups.push({
        key: job.jobName,
        status: job.status,
        source: job.source,
        provider: job.provider,
        errorMessage: job.errorMessage ?? null,
        totalItems: job.itemCount,
        newestJob: job,
        oldestJob: job,
        jobs: [job],
      })
    }
    return groups
  })

  async function loadLlmBatchJobs(): Promise<void> {
    if (loadLlmBatchJobsInFlight) return loadLlmBatchJobsInFlight
    loadLlmBatchJobsInFlight = (async () => {
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
    })().finally(() => {
      loadLlmBatchJobsInFlight = null
    })
    return loadLlmBatchJobsInFlight
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
    llmBatchRecentGroups,
    formatBatchDate,
    loadLlmBatchJobs,
    startProgressPolling,
    stopProgressPolling,
    anyTrackedTaskRunning,
  }
}
