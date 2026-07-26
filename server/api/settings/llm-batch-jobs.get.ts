// Admin overview for explicit LLM Batch API jobs that are still in flight.
// Joins the durable job table with extraction_cache's per-item `llmBatchJob`
// markers so /settings can show both "how many" and "which" requests are
// currently waiting for a provider response.

import { listPendingLlmBatchJobs } from '~/server/utils/llm-batch-jobs'
import { readExtractionCache } from '~/server/utils/extraction-cache'

export interface LlmBatchJobOverviewItem {
  jobName: string
  source: 'enrich' | 'reprocess'
  status: 'pending'
  provider: 'anthropic' | 'gemini'
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
  jobs: LlmBatchJobOverviewItem[]
}

export default defineEventHandler(async (): Promise<LlmBatchJobsOverview> => {
  const jobs = await listPendingLlmBatchJobs()
  const cache = await readExtractionCache()
  const keysByJob = new Map<string, string[]>()
  for (const [key, entry] of Object.entries(cache)) {
    if (!entry.llmBatchJob) continue
    const arr = keysByJob.get(entry.llmBatchJob) ?? []
    arr.push(key)
    keysByJob.set(entry.llmBatchJob, arr)
  }

  const overviewJobs = jobs.map((job): LlmBatchJobOverviewItem => {
    const requestKeys = [...new Set([
      ...(keysByJob.get(job.jobName) ?? []),
      ...Object.values(job.customIdMap),
    ])].sort()
    return {
      jobName: job.jobName,
      source: job.source,
      status: 'pending',
      provider: job.jobName.startsWith('msgbatch_') ? 'anthropic' : 'gemini',
      itemCount: job.itemCount,
      pendingCount: requestKeys.length || job.itemCount,
      requestKeys,
      submittedAt: job.submittedAt,
      checkedAt: job.checkedAt,
      updatedAt: job.updatedAt,
    }
  })

  return {
    totalJobs: overviewJobs.length,
    totalRequests: overviewJobs.reduce((sum, job) => sum + job.pendingCount, 0),
    jobs: overviewJobs,
  }
})
