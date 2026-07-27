// Tracks in-flight LLM Batch API jobs (server/utils/extract/*-batch.ts)
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
  customIdMap: Record<string, string>
  submittedAt: string
  checkedAt: string | null
  updatedAt: string
}

export interface GeminiBatchQuotaUsage {
  day: string
  jobs: number
  items: number
  estimatedTokens: number
  backoffUntil: string | null
}

const GEMINI_BATCH_QUOTA_KEY = 'gemini_batch_quota_usage'

let memoryGeminiQuotaUsage: GeminiBatchQuotaUsage | null = null

function defaultGeminiQuotaUsage(day: string): GeminiBatchQuotaUsage {
  return { day, jobs: 0, items: 0, estimatedTokens: 0, backoffUntil: null }
}

function coerceGeminiQuotaUsage(value: unknown, day: string): GeminiBatchQuotaUsage {
  if (!value || typeof value !== 'object') return defaultGeminiQuotaUsage(day)
  const v = value as Record<string, unknown>
  if (v.day !== day) return defaultGeminiQuotaUsage(day)
  return {
    day,
    jobs: typeof v.jobs === 'number' && Number.isFinite(v.jobs) && v.jobs > 0 ? Math.round(v.jobs) : 0,
    items: typeof v.items === 'number' && Number.isFinite(v.items) && v.items > 0 ? Math.round(v.items) : 0,
    estimatedTokens:
      typeof v.estimatedTokens === 'number' && Number.isFinite(v.estimatedTokens) && v.estimatedTokens > 0
        ? Math.round(v.estimatedTokens)
        : 0,
    backoffUntil: typeof v.backoffUntil === 'string' && v.backoffUntil ? v.backoffUntil : null,
  }
}

export async function readGeminiBatchQuotaUsage(day: string): Promise<GeminiBatchQuotaUsage> {
  const db = getPool()
  if (!db) {
    memoryGeminiQuotaUsage = coerceGeminiQuotaUsage(memoryGeminiQuotaUsage, day)
    return memoryGeminiQuotaUsage
  }
  try {
    const { rows } = await db.query<{ value: unknown }>(
      'SELECT value FROM app_settings WHERE key = $1',
      [GEMINI_BATCH_QUOTA_KEY],
    )
    return coerceGeminiQuotaUsage(rows[0]?.value, day)
  } catch (err) {
    console.warn(`[llm-batch-jobs] Gemini quota read failed: ${(err as Error).message}`)
    memoryGeminiQuotaUsage = coerceGeminiQuotaUsage(memoryGeminiQuotaUsage, day)
    return memoryGeminiQuotaUsage
  }
}

export async function recordGeminiBatchQuotaUsage(
  day: string,
  delta: { jobs: number; items: number; estimatedTokens: number },
): Promise<void> {
  const current = await readGeminiBatchQuotaUsage(day)
  const next: GeminiBatchQuotaUsage = {
    day,
    jobs: current.jobs + Math.max(0, Math.round(delta.jobs)),
    items: current.items + Math.max(0, Math.round(delta.items)),
    estimatedTokens: current.estimatedTokens + Math.max(0, Math.round(delta.estimatedTokens)),
    backoffUntil: current.backoffUntil,
  }
  const db = getPool()
  if (!db) {
    memoryGeminiQuotaUsage = next
    return
  }
  try {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
      [GEMINI_BATCH_QUOTA_KEY, JSON.stringify(next)],
    )
  } catch (err) {
    console.warn(`[llm-batch-jobs] Gemini quota write failed: ${(err as Error).message}`)
    memoryGeminiQuotaUsage = next
  }
}

export async function setGeminiBatchQuotaBackoff(day: string, backoffUntil: string): Promise<void> {
  const current = await readGeminiBatchQuotaUsage(day)
  const next: GeminiBatchQuotaUsage = { ...current, backoffUntil }
  const db = getPool()
  if (!db) {
    memoryGeminiQuotaUsage = next
    return
  }
  try {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
      [GEMINI_BATCH_QUOTA_KEY, JSON.stringify(next)],
    )
  } catch (err) {
    console.warn(`[llm-batch-jobs] Gemini quota backoff write failed: ${(err as Error).message}`)
    memoryGeminiQuotaUsage = next
  }
}

/** Returns whether the row was recorded, so the caller can
 *  treat a failed insert as a failed submission instead of returning a job
 *  name the poller will never see. */
export async function insertLlmBatchJob(job: {
  jobName: string
  source: 'enrich' | 'reprocess'
  itemCount: number
  customIdMap?: Record<string, string>
}): Promise<boolean> {
  const db = getPool()
  if (!db) return true
  try {
    await db.query(
      'INSERT INTO llm_batch_jobs (job_name, source, item_count, custom_id_map) VALUES ($1, $2, $3, $4::jsonb)',
      [job.jobName, job.source, job.itemCount, JSON.stringify(job.customIdMap ?? {})],
    )
    return true
  } catch (err) {
    console.warn(`[llm-batch-jobs] insert failed for ${job.jobName}: ${(err as Error).message}`)
    return false
  }
}

export async function listPendingLlmBatchJobs(): Promise<LlmBatchJob[]> {
  const db = getPool()
  if (!db) return []
  try {
    const { rows } = await db.query<{
      job_name: string
      source: string
      status: string
      item_count: number
      custom_id_map: unknown
      submitted_at: Date | string
      checked_at: Date | string | null
      updated_at: Date | string
    }>(
      `SELECT job_name, source, status, item_count, custom_id_map, submitted_at, checked_at, updated_at
       FROM llm_batch_jobs
       WHERE status = 'pending'
       ORDER BY submitted_at ASC`,
    )
    return rows.map((r) => ({
      jobName: r.job_name,
      source: r.source as 'enrich' | 'reprocess',
      status: r.status as LlmBatchJobStatus,
      itemCount: r.item_count,
      customIdMap: isStringMap(r.custom_id_map) ? r.custom_id_map : {},
      submittedAt: toIso(r.submitted_at),
      checkedAt: r.checked_at == null ? null : toIso(r.checked_at),
      updatedAt: toIso(r.updated_at),
    }))
  } catch (err) {
    console.warn(`[llm-batch-jobs] list failed: ${(err as Error).message}`)
    return []
  }
}

export async function markLlmBatchJobChecked(jobName: string, checkedAt: string): Promise<void> {
  const db = getPool()
  if (!db) return
  try {
    await db.query(
      'UPDATE llm_batch_jobs SET checked_at = $2, updated_at = now() WHERE job_name = $1',
      [jobName, checkedAt],
    )
  } catch (err) {
    console.warn(`[llm-batch-jobs] checked_at update failed for ${jobName}: ${(err as Error).message}`)
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  )
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
