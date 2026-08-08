// Admin overview for explicit LLM Batch API jobs and structured extraction backlog.
// Joins the durable job table with auction_fetch_state's per-item markers so
// /settings can show both "how many" and "which" requests are
// currently waiting for a provider response, plus enough history/backlog
// context to debug why listings are still rules-only.

import type { AuctionExtraction } from '~/types/auction'
import { MAX_LLM_FAILURES } from '~/lib/llm-limits'
import {
  getAllLlmBatchCapabilities,
  listPendingLlmBatchJobs,
  listRecentLlmBatchJobs,
  type LlmBatchCapability,
  type LlmBatchJobStatus,
} from '~/server/utils/llm-batch-jobs'
import { readAuctionRecords } from '~/server/utils/auction-record'
import { readAuctionFetchStates } from '~/server/utils/auction-fetch-state'
import { cacheKey } from '~/server/utils/verkehrswert-cache'
import { isGeminiBatchTierPaid } from '~/server/utils/extract/gemini-batch'
import { getTaskRunStatus, type TaskRunStatus } from '~/server/utils/task-runs'

export interface LlmBatchJobOverviewItem {
  jobName: string
  source: 'enrich' | 'reprocess'
  status: LlmBatchJobStatus
  provider: 'anthropic' | 'gemini' | 'openai' | 'openrouter'
  itemCount: number
  pendingCount: number
  requestKeys: string[]
  submittedAt: string
  checkedAt: string | null
  updatedAt: string
  errorMessage: string | null
}

export interface LlmBatchJobsOverview {
  totalJobs: number
  totalRequests: number
  backlog: {
    readyRequests: number
    lowConfidenceRules: number
    missingLlmFields: number
    orphanedBatchMarkers: number
    failedLimit: number
    sampleRequestKeys: string[]
    orphanedRequestKeys: string[]
  }
  jobs: LlmBatchJobOverviewItem[]
  recentJobs: LlmBatchJobOverviewItem[]
  // Keyed by LlmProvider ('gemini-native' | 'openai-compatible' | 'claude-proxy'
  // | 'openrouter')
  // — whether the *last real* batch submit attempt for that provider was
  // accepted, so /settings can show why batch mode currently isn't running
  // instead of a silently stuck backlog.
  capabilities: Record<string, LlmBatchCapability>
  // The extraction task's status, not the crawl/archive task's — this is the
  // one that actually calls the LLM (see server/tasks/reprocess.ts).
  reprocessStatus: TaskRunStatus
  // The crawl/archive task's status (server/tasks/enrich.ts) — never calls
  // an LLM, so it's tracked separately from reprocessStatus above.
  enrichStatus: TaskRunStatus
  // The external market/hazard overlay task's status. /settings triggers it
  // detached, so this is the only place its failures surface.
  externalEnrichmentStatus: TaskRunStatus
  // Photo offload to the images bucket — scheduled only, so its status is the
  // one place to see whether the server volume is actually being drained.
  offloadImagesStatus: TaskRunStatus
}

const MAX_KEYS_PER_GROUP = 200

function providerForJob(jobName: string): LlmBatchJobOverviewItem['provider'] {
  // Checked first — OpenRouter's own batch ids also start with "batch_" (see
  // openrouter-batch.ts), so our "openrouter_"-wrapped jobName must be
  // matched before the "batch_" (OpenAI) branch.
  if (jobName.startsWith('openrouter_')) return 'openrouter'
  if (jobName.startsWith('msgbatch_')) return 'anthropic'
  if (jobName.startsWith('batch_')) return 'openai'
  return 'gemini'
}

function hasMissingLlmFields(entry: AuctionExtraction): boolean {
  return (
    entry.condition === undefined ||
    entry.features === undefined ||
    entry.bedrooms === undefined ||
    entry.bathrooms === undefined ||
    entry.floor === undefined ||
    entry.bathroomHasTub === undefined ||
    entry.bathroomHasShower === undefined ||
    entry.heating === undefined ||
    entry.yearBuilt === undefined ||
    entry.lastRenovationYear === undefined ||
    entry.renovationNotes === undefined ||
    entry.insights === undefined ||
    entry.planningNotes === undefined ||
    entry.documentSummary === undefined ||
    entry.marketValueEur === undefined
  )
}

export default defineEventHandler(async (): Promise<LlmBatchJobsOverview> => {
  const [
    jobs,
    recentJobs,
    capabilities,
    reprocessStatus,
    enrichStatus,
    externalEnrichmentStatus,
    offloadImagesStatus,
  ] = await Promise.all([
    listPendingLlmBatchJobs(),
    listRecentLlmBatchJobs(20),
    getAllLlmBatchCapabilities(),
    getTaskRunStatus('reprocess'),
    getTaskRunStatus('enrich'),
    getTaskRunStatus('external-enrichment'),
    getTaskRunStatus('offload-images'),
  ])
  // supportsLlmBatch() gates gemini-native on isGeminiBatchTierPaid() (see
  // llm-batch.ts), so on the free tier a real batch submit never happens and
  // recordLlmBatchCapability never fires — capabilities['gemini-native'] would
  // stay empty forever, silently hiding why batch mode isn't running. Fill
  // that gap from the static config instead of a real attempt. Copy first:
  // getAllLlmBatchCapabilities() can return the shared in-memory fallback
  // object directly, and mutating it here would leak into later requests.
  const effectiveCapabilities = { ...capabilities }
  if (!effectiveCapabilities['gemini-native'] && !isGeminiBatchTierPaid()) {
    effectiveCapabilities['gemini-native'] = {
      ok: false,
      message: null,
      checkedAt: new Date().toISOString(),
      source: 'config',
    }
  }
  const records = await readAuctionRecords(undefined, { includePhotos: false })
  const fetchStates = await readAuctionFetchStates()
  const keysByJob = new Map<string, string[]>()
  const pendingJobNames = new Set(jobs.map((job) => job.jobName))
  const knownRecentJobNames = new Set(recentJobs.map((job) => job.jobName))
  let readyRequests = 0
  let lowConfidenceRules = 0
  let missingLlmFields = 0
  let orphanedBatchMarkers = 0
  let failedLimit = 0
  const sampleRequestKeys: string[] = []
  const orphanedRequestKeys: string[] = []

  for (const { auction } of records) {
    const entry = auction.extraction
    const key = cacheKey(auction.platform, auction.externalId)
    const state = fetchStates.get(key)
    if (state?.llmBatchJob) {
      const arr = keysByJob.get(state.llmBatchJob) ?? []
      arr.push(key)
      keysByJob.set(state.llmBatchJob, arr)
      if (!pendingJobNames.has(state.llmBatchJob) && !knownRecentJobNames.has(state.llmBatchJob)) {
        orphanedBatchMarkers++
        if (orphanedRequestKeys.length < MAX_KEYS_PER_GROUP) orphanedRequestKeys.push(key)
      }
      continue
    }
    if (!entry) continue

    const lowRules = entry.source === 'rules' && entry.confidence === 'low'
    const missingFields = hasMissingLlmFields(entry)
    if (lowRules) lowConfidenceRules++
    if (missingFields) missingLlmFields++
    if ((state?.llmFailures ?? 0) >= MAX_LLM_FAILURES) {
      failedLimit++
      continue
    }
    if (lowRules || missingFields) {
      readyRequests++
      if (sampleRequestKeys.length < MAX_KEYS_PER_GROUP) sampleRequestKeys.push(key)
    }
  }

  const mapJob = (job: (typeof recentJobs)[number]): LlmBatchJobOverviewItem => {
    const requestKeys = [...new Set([
      ...(keysByJob.get(job.jobName) ?? []),
      ...Object.values(job.customIdMap),
    ])].sort()
    return {
      jobName: job.jobName,
      source: job.source,
      status: job.status,
      provider: providerForJob(job.jobName),
      itemCount: job.itemCount,
      pendingCount: job.status === 'pending' ? requestKeys.length || job.itemCount : 0,
      requestKeys,
      submittedAt: job.submittedAt,
      checkedAt: job.checkedAt,
      updatedAt: job.updatedAt,
      errorMessage: job.errorMessage,
    }
  }

  const overviewJobs = jobs.map(mapJob)

  return {
    totalJobs: overviewJobs.length,
    totalRequests: overviewJobs.reduce((sum, job) => sum + job.pendingCount, 0),
    backlog: {
      readyRequests,
      lowConfidenceRules,
      missingLlmFields,
      orphanedBatchMarkers,
      failedLimit,
      sampleRequestKeys: sampleRequestKeys.sort(),
      orphanedRequestKeys: orphanedRequestKeys.sort(),
    },
    jobs: overviewJobs,
    recentJobs: recentJobs.map(mapJob),
    capabilities: effectiveCapabilities,
    reprocessStatus,
    enrichStatus,
    externalEnrichmentStatus,
    offloadImagesStatus,
  }
})
