// Admin overview for explicit LLM Batch API jobs and extraction-cache backlog.
// Joins the durable job table with extraction_cache's per-item `llmBatchJob`
// markers so /settings can show both "how many" and "which" requests are
// currently waiting for a provider response, plus enough history/backlog
// context to debug why listings are still rules-only.

import type { AuctionExtraction } from '~/types/auction'
import { MAX_LLM_FAILURES } from '~/lib/llm-limits'
import { listPendingLlmBatchJobs, listRecentLlmBatchJobs, type LlmBatchJobStatus } from '~/server/utils/llm-batch-jobs'
import { readExtractionCache } from '~/server/utils/extraction-cache'

export interface LlmBatchJobOverviewItem {
  jobName: string
  source: 'enrich' | 'reprocess'
  status: LlmBatchJobStatus
  provider: 'anthropic' | 'gemini' | 'openai'
  itemCount: number
  pendingCount: number
  requestKeys: string[]
  submittedAt: string
  checkedAt: string | null
  updatedAt: string
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
}

const MAX_KEYS_PER_GROUP = 200

function providerForJob(jobName: string): LlmBatchJobOverviewItem['provider'] {
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
  const [jobs, recentJobs] = await Promise.all([
    listPendingLlmBatchJobs(),
    listRecentLlmBatchJobs(20),
  ])
  const cache = await readExtractionCache()
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

  for (const [key, entry] of Object.entries(cache)) {
    if (entry.llmBatchJob) {
      const arr = keysByJob.get(entry.llmBatchJob) ?? []
      arr.push(key)
      keysByJob.set(entry.llmBatchJob, arr)
      if (!pendingJobNames.has(entry.llmBatchJob) && !knownRecentJobNames.has(entry.llmBatchJob)) {
        orphanedBatchMarkers++
        if (orphanedRequestKeys.length < MAX_KEYS_PER_GROUP) orphanedRequestKeys.push(key)
      }
      continue
    }

    const lowRules = entry.source === 'rules' && entry.confidence === 'low'
    const missingFields = hasMissingLlmFields(entry)
    if (lowRules) lowConfidenceRules++
    if (missingFields) missingLlmFields++
    if ((entry.llmFailures ?? 0) >= MAX_LLM_FAILURES) {
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
  }
})
