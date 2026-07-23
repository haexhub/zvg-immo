// Tracks in-flight Gemini Batch API jobs (server/utils/extract/gemini-batch.ts)
// so llm-batch-poll.ts knows what to check and enrich.ts/reprocess.ts can
// avoid double-submitting while a job is still open (see AuctionExtraction's
// `llmBatchJob` marker). No in-process memoization like extraction-cache.ts —
// this table has too few rows for caching to be worth the invalidation
// complexity; a live read per poll tick is simpler. Same graceful-no-op
// pattern as extraction-cache.ts: getPool() → null without NUXT_DATABASE_URL.

import { getPool } from './db'

export type LlmBatchJobStatus = 'pending' | 'succeeded' | 'failed' | 'expired'

export interface LlmBatchJob {
  jobName: string
  source: 'enrich' | 'reprocess'
  status: LlmBatchJobStatus
  itemCount: number
}

export async function insertLlmBatchJob(job: {
  jobName: string
  source: 'enrich' | 'reprocess'
  itemCount: number
}): Promise<void> {
  const db = getPool()
  if (!db) return
  try {
    await db.query(
      'INSERT INTO llm_batch_jobs (job_name, source, item_count) VALUES ($1, $2, $3)',
      [job.jobName, job.source, job.itemCount],
    )
  } catch (err) {
    console.warn(`[llm-batch-jobs] insert failed for ${job.jobName}: ${(err as Error).message}`)
  }
}

export async function listPendingLlmBatchJobs(): Promise<LlmBatchJob[]> {
  const db = getPool()
  if (!db) return []
  try {
    const { rows } = await db.query<{ job_name: string; source: string; status: string; item_count: number }>(
      "SELECT job_name, source, status, item_count FROM llm_batch_jobs WHERE status = 'pending'",
    )
    return rows.map((r) => ({
      jobName: r.job_name,
      source: r.source as 'enrich' | 'reprocess',
      status: r.status as LlmBatchJobStatus,
      itemCount: r.item_count,
    }))
  } catch (err) {
    console.warn(`[llm-batch-jobs] list failed: ${(err as Error).message}`)
    return []
  }
}

/** Removes a job's row once llm-batch-poll.ts has resolved it (succeeded,
 *  failed, or expired) — simpler than tracking terminal status/checked_at on
 *  the row, since there's no cleanup task needed either way. */
export async function deleteLlmBatchJob(jobName: string): Promise<void> {
  const db = getPool()
  if (!db) return
  try {
    await db.query('DELETE FROM llm_batch_jobs WHERE job_name = $1', [jobName])
  } catch (err) {
    console.warn(`[llm-batch-jobs] delete failed for ${jobName}: ${(err as Error).message}`)
  }
}
