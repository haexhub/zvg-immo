// Admin overview for explicit LLM Batch API jobs and structured extraction backlog.
// Joins the durable job table with auction_fetch_state's per-item markers so
// /settings can show both "how many" and "which" requests are
// currently waiting for a provider response, plus enough history/backlog
// context to debug why listings are still rules-only.

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
import { hasMissingLlmFields } from '~/server/utils/llm-status'
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
    neverExtracted: number
    lowConfidenceRules: number
    missingLlmFields: number
    orphanedBatchMarkers: number
    failedLimit: number
    sampleRequestKeys: string[]
    orphanedRequestKeys: string[]
  }
  // Same readyRequests/failedLimit split as `backlog`, grouped by
  // auctions.country — lets /settings offer a per-country "process now"
  // trigger instead of only a global count. Countries with neither an open
  // nor a locked-out item are omitted.
  backlogByCountry: Record<string, { readyRequests: number; failedLimit: number }>
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
  // The Copernicus EFFIS burnt-area cache import. /settings triggers it
  // detached (its WFS dataset is too big to fetch within a request) so this
  // is the only place to see whether an "Import" click actually did anything.
  copernicusEffisImportStatus: TaskRunStatus
  // Same for the EU flood risk polygon cache import.
  euFloodRiskImportStatus: TaskRunStatus
}

// Also caps each job's own requestKeys array below (a real Batch API
// submission's customIdMap can hold thousands of entries) — without that
// cap, MAX_PENDING_JOBS_DISPLAYED alone still let a handful of large/orphaned
// pending jobs balloon the response into multiple MB on every poll.
const MAX_KEYS_PER_GROUP = 200
// Bounds the detailed per-job payload independently of totalJobs/
// totalRequests below, which stay computed from the full list — a
// pending-job backlog (e.g. many jobs stuck on a broken provider) must not
// balloon the response just because /settings polls this endpoint every few
// seconds while a task is running.
const MAX_PENDING_JOBS_DISPLAYED = 50

// useSettingsTaskOverview.ts polls this endpoint every 3s for as long as any
// tracked task is running, which can be tens of minutes for a slow sync LLM
// backlog — recomputing the full cross-country auction scan below on every
// tick was measured at several MB per response. A short cache lets bursts of
// near-simultaneous polls (multiple open /settings tabs, or the client's own
// mount-time + interval calls) share one computation; staleness of a few
// seconds is invisible on a progress counter.
const OVERVIEW_CACHE_TTL_MS = 4000
let cachedOverview: { data: LlmBatchJobsOverview; expiresAt: number } | null = null

function providerForJob(jobName: string): LlmBatchJobOverviewItem['provider'] {
  // Checked first — OpenRouter's own batch ids also start with "batch_" (see
  // openrouter-batch.ts), so our "openrouter_"-wrapped jobName must be
  // matched before the "batch_" (OpenAI) branch.
  if (jobName.startsWith('openrouter_')) return 'openrouter'
  if (jobName.startsWith('msgbatch_')) return 'anthropic'
  if (jobName.startsWith('batch_')) return 'openai'
  return 'gemini'
}

export default defineEventHandler(async (): Promise<LlmBatchJobsOverview> => {
  if (cachedOverview && cachedOverview.expiresAt > Date.now()) return cachedOverview.data

  const [
    jobs,
    recentJobs,
    capabilities,
    reprocessStatus,
    enrichStatus,
    externalEnrichmentStatus,
    offloadImagesStatus,
    copernicusEffisImportStatus,
    euFloodRiskImportStatus,
  ] = await Promise.all([
    listPendingLlmBatchJobs(),
    listRecentLlmBatchJobs(20),
    getAllLlmBatchCapabilities(),
    getTaskRunStatus('reprocess'),
    getTaskRunStatus('enrich'),
    getTaskRunStatus('external-enrichment'),
    getTaskRunStatus('offload-images'),
    getTaskRunStatus('import-copernicus-effis-cache'),
    getTaskRunStatus('import-eu-flood-risk-cache'),
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
  let neverExtracted = 0
  let lowConfidenceRules = 0
  let missingLlmFields = 0
  let orphanedBatchMarkers = 0
  let failedLimit = 0
  const sampleRequestKeys: string[] = []
  const orphanedRequestKeys: string[] = []
  const backlogByCountry = new Map<string, { readyRequests: number; failedLimit: number }>()
  function countryBucket(country: string): { readyRequests: number; failedLimit: number } {
    let bucket = backlogByCountry.get(country)
    if (!bucket) {
      bucket = { readyRequests: 0, failedLimit: 0 }
      backlogByCountry.set(country, bucket)
    }
    return bucket
  }

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

    // No auction_details row at all — a brand-new crawl this task's cron
    // hasn't reached yet, never run through even the rules-only fallback.
    // Previously fell through the `!entry` guard below and never counted
    // toward readyRequests, silently undercounting the true open backlog.
    const isUnextracted = !entry
    const lowRules = !isUnextracted && entry.source === 'rules' && entry.confidence === 'low'
    const missingFields = !isUnextracted && hasMissingLlmFields(entry)
    if (isUnextracted) neverExtracted++
    if (lowRules) lowConfidenceRules++
    if (missingFields) missingLlmFields++
    if ((state?.llmFailures ?? 0) >= MAX_LLM_FAILURES) {
      failedLimit++
      countryBucket(auction.country).failedLimit++
      continue
    }
    if (isUnextracted || lowRules || missingFields) {
      readyRequests++
      countryBucket(auction.country).readyRequests++
      if (sampleRequestKeys.length < MAX_KEYS_PER_GROUP) sampleRequestKeys.push(key)
    }
  }

  const mapJob = (job: (typeof recentJobs)[number]): LlmBatchJobOverviewItem => {
    const allRequestKeys = [...new Set([
      ...(keysByJob.get(job.jobName) ?? []),
      ...Object.values(job.customIdMap),
    ])].sort()
    return {
      jobName: job.jobName,
      source: job.source,
      status: job.status,
      provider: providerForJob(job.jobName),
      itemCount: job.itemCount,
      pendingCount: job.status === 'pending' ? allRequestKeys.length || job.itemCount : 0,
      requestKeys: allRequestKeys.slice(0, MAX_KEYS_PER_GROUP),
      submittedAt: job.submittedAt,
      checkedAt: job.checkedAt,
      updatedAt: job.updatedAt,
      errorMessage: job.errorMessage,
    }
  }

  // jobs is already status:'pending' (see listPendingLlmBatchJobs), so every
  // item counts toward totalRequests — using itemCount directly instead of
  // mapJob's deduped requestKeys avoids building that array for jobs beyond
  // the display cap just to total them.
  const overviewJobs = jobs.slice(0, MAX_PENDING_JOBS_DISPLAYED).map(mapJob)

  const result: LlmBatchJobsOverview = {
    totalJobs: jobs.length,
    totalRequests: jobs.reduce((sum, job) => sum + job.itemCount, 0),
    backlog: {
      readyRequests,
      neverExtracted,
      lowConfidenceRules,
      missingLlmFields,
      orphanedBatchMarkers,
      failedLimit,
      sampleRequestKeys: sampleRequestKeys.sort(),
      orphanedRequestKeys: orphanedRequestKeys.sort(),
    },
    backlogByCountry: Object.fromEntries(backlogByCountry),
    jobs: overviewJobs,
    recentJobs: recentJobs.map(mapJob),
    capabilities: effectiveCapabilities,
    reprocessStatus,
    enrichStatus,
    externalEnrichmentStatus,
    offloadImagesStatus,
    copernicusEffisImportStatus,
    euFloodRiskImportStatus,
  }
  cachedOverview = { data: result, expiresAt: Date.now() + OVERVIEW_CACHE_TTL_MS }
  return result
})
