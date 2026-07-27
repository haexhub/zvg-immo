// Tracks in-flight LLM Batch API jobs (server/utils/extract/*-batch.ts)
// so llm-batch-poll.ts knows what to check and enrich.ts/reprocess.ts can
// avoid double-submitting while a job is still open (see AuctionExtraction's
// `llmBatchJob` marker). No in-process memoization like extraction-cache.ts —
// this table has too few rows for caching to be worth the invalidation
// complexity; a live read per poll tick is simpler. Same graceful-no-op
// pattern as extraction-cache.ts: getPool() → null without NUXT_DATABASE_URL.

import type { PoolClient } from 'pg'
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
  errorMessage: string | null
}

// Records whether the *last* real attempt (not a deliberate quota/backoff
// skip) to submit a batch for this provider actually reached the provider
// and was accepted — e.g. Gemini's free tier rejects batchGenerateContent
// outright with 400 FAILED_PRECONDITION, a fact no static config flag can
// capture reliably. enrich.ts/reprocess.ts read this alongside
// supportsLlmBatch() so a confirmed-broken provider falls back to the
// synchronous path automatically instead of submitting doomed jobs forever,
// and /settings surfaces the real message instead of a silent stuck backlog.
export interface LlmBatchCapability {
  ok: boolean
  message: string | null
  checkedAt: string
  source: 'enrich' | 'reprocess'
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
let memoryGeminiQuotaLock: Promise<void> = Promise.resolve()

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
  const safeDelta = {
    jobs: Math.max(0, Math.round(delta.jobs)),
    items: Math.max(0, Math.round(delta.items)),
    estimatedTokens: Math.max(0, Math.round(delta.estimatedTokens)),
  }
  const db = getPool()
  if (!db) {
    const current = await readGeminiBatchQuotaUsage(day)
    const next: GeminiBatchQuotaUsage = {
      day,
      jobs: current.jobs + safeDelta.jobs,
      items: current.items + safeDelta.items,
      estimatedTokens: current.estimatedTokens + safeDelta.estimatedTokens,
      backoffUntil: current.backoffUntil,
    }
    memoryGeminiQuotaUsage = next
    return
  }
  try {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (
         $1,
         jsonb_build_object(
           'day', $2::text,
           'jobs', $3::integer,
           'items', $4::integer,
           'estimatedTokens', $5::integer,
           'backoffUntil', NULL::text
         ),
         now()
       )
       ON CONFLICT (key) DO UPDATE SET
         value = CASE
           WHEN app_settings.value->>'day' = $2::text THEN jsonb_build_object(
             'day', $2::text,
             'jobs', (CASE WHEN app_settings.value->>'jobs' ~ '^[0-9]+$' THEN (app_settings.value->>'jobs')::integer ELSE 0 END) + $3::integer,
             'items', (CASE WHEN app_settings.value->>'items' ~ '^[0-9]+$' THEN (app_settings.value->>'items')::integer ELSE 0 END) + $4::integer,
             'estimatedTokens', (CASE WHEN app_settings.value->>'estimatedTokens' ~ '^[0-9]+$' THEN (app_settings.value->>'estimatedTokens')::integer ELSE 0 END) + $5::integer,
             'backoffUntil', NULLIF(app_settings.value->>'backoffUntil', '')
           )
           ELSE jsonb_build_object(
             'day', $2::text,
             'jobs', $3::integer,
             'items', $4::integer,
             'estimatedTokens', $5::integer,
             'backoffUntil', NULL::text
           )
         END,
         updated_at = now()`,
      [GEMINI_BATCH_QUOTA_KEY, day, safeDelta.jobs, safeDelta.items, safeDelta.estimatedTokens],
    )
  } catch (err) {
    console.warn(`[llm-batch-jobs] Gemini quota write failed: ${(err as Error).message}`)
    const current = await readGeminiBatchQuotaUsage(day)
    memoryGeminiQuotaUsage = {
      day,
      jobs: current.jobs + safeDelta.jobs,
      items: current.items + safeDelta.items,
      estimatedTokens: current.estimatedTokens + safeDelta.estimatedTokens,
      backoffUntil: current.backoffUntil,
    }
  }
}

export async function setGeminiBatchQuotaBackoff(day: string, backoffUntil: string): Promise<void> {
  const db = getPool()
  if (!db) {
    const current = await readGeminiBatchQuotaUsage(day)
    const next: GeminiBatchQuotaUsage = { ...current, backoffUntil }
    memoryGeminiQuotaUsage = next
    return
  }
  try {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (
         $1,
         jsonb_build_object('day', $2::text, 'jobs', 0, 'items', 0, 'estimatedTokens', 0, 'backoffUntil', $3::text),
         now()
       )
       ON CONFLICT (key) DO UPDATE SET
         value = CASE
           WHEN app_settings.value->>'day' = $2::text THEN jsonb_build_object(
             'day', $2::text,
             'jobs', CASE WHEN app_settings.value->>'jobs' ~ '^[0-9]+$' THEN (app_settings.value->>'jobs')::integer ELSE 0 END,
             'items', CASE WHEN app_settings.value->>'items' ~ '^[0-9]+$' THEN (app_settings.value->>'items')::integer ELSE 0 END,
             'estimatedTokens', CASE WHEN app_settings.value->>'estimatedTokens' ~ '^[0-9]+$' THEN (app_settings.value->>'estimatedTokens')::integer ELSE 0 END,
             'backoffUntil', $3::text
           )
           ELSE jsonb_build_object('day', $2::text, 'jobs', 0, 'items', 0, 'estimatedTokens', 0, 'backoffUntil', $3::text)
         END,
         updated_at = now()`,
      [GEMINI_BATCH_QUOTA_KEY, day, backoffUntil],
    )
  } catch (err) {
    console.warn(`[llm-batch-jobs] Gemini quota backoff write failed: ${(err as Error).message}`)
    const current = await readGeminiBatchQuotaUsage(day)
    const next: GeminiBatchQuotaUsage = { ...current, backoffUntil }
    memoryGeminiQuotaUsage = next
  }
}

const LLM_BATCH_CAPABILITY_KEY = 'llm_batch_capability'

let memoryLlmBatchCapability: Record<string, LlmBatchCapability> = {}

function coerceLlmBatchCapabilityEntry(value: unknown): LlmBatchCapability | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.ok !== 'boolean') return null
  if (typeof v.checkedAt !== 'string' || !v.checkedAt) return null
  if (v.source !== 'enrich' && v.source !== 'reprocess') return null
  return {
    ok: v.ok,
    message: typeof v.message === 'string' && v.message ? v.message : null,
    checkedAt: v.checkedAt,
    source: v.source,
  }
}

function coerceLlmBatchCapabilityMap(value: unknown): Record<string, LlmBatchCapability> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, LlmBatchCapability> = {}
  for (const [provider, raw] of Object.entries(value as Record<string, unknown>)) {
    const entry = coerceLlmBatchCapabilityEntry(raw)
    if (entry) out[provider] = entry
  }
  return out
}

export async function getAllLlmBatchCapabilities(): Promise<Record<string, LlmBatchCapability>> {
  const db = getPool()
  if (!db) return memoryLlmBatchCapability
  try {
    const { rows } = await db.query<{ value: unknown }>(
      'SELECT value FROM app_settings WHERE key = $1',
      [LLM_BATCH_CAPABILITY_KEY],
    )
    return coerceLlmBatchCapabilityMap(rows[0]?.value)
  } catch (err) {
    console.warn(`[llm-batch-jobs] capability read failed: ${(err as Error).message}`)
    return memoryLlmBatchCapability
  }
}

export async function getLlmBatchCapability(provider: string): Promise<LlmBatchCapability | null> {
  const all = await getAllLlmBatchCapabilities()
  return all[provider] ?? null
}

export async function recordLlmBatchCapability(
  provider: string,
  entry: { ok: boolean; message: string | null; source: 'enrich' | 'reprocess' },
): Promise<void> {
  const checkedAt = new Date().toISOString()
  const next: LlmBatchCapability = { ok: entry.ok, message: entry.message, checkedAt, source: entry.source }
  const db = getPool()
  if (!db) {
    memoryLlmBatchCapability = { ...memoryLlmBatchCapability, [provider]: next }
    return
  }
  try {
    // Atomic per-provider merge (no read-then-write) — enrich.ts and
    // reprocess.ts run as independent background tasks that can submit
    // concurrently, and a read-then-overwrite here could let one call's
    // stale snapshot clobber another provider's just-written capability.
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, jsonb_build_object($2::text, $3::jsonb), now())
       ON CONFLICT (key) DO UPDATE SET
         value = app_settings.value || jsonb_build_object($2::text, $3::jsonb),
         updated_at = now()`,
      [LLM_BATCH_CAPABILITY_KEY, provider, JSON.stringify(next)],
    )
  } catch (err) {
    console.warn(`[llm-batch-jobs] capability write failed for ${provider}: ${(err as Error).message}`)
    memoryLlmBatchCapability = { ...memoryLlmBatchCapability, [provider]: next }
  }
}

export async function withGeminiBatchQuotaLock<T>(fn: () => Promise<T>): Promise<T> {
  const db = getPool()
  if (!db) return withMemoryGeminiBatchQuotaLock(fn)
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [GEMINI_BATCH_QUOTA_KEY])
    const result = await fn()
    await client.query('COMMIT')
    return result
  } catch (err) {
    await rollbackQuietly(client)
    throw err
  } finally {
    client.release()
  }
}

async function withMemoryGeminiBatchQuotaLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = memoryGeminiQuotaLock
  let release!: () => void
  memoryGeminiQuotaLock = new Promise((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch {
    // Best-effort cleanup before releasing the client.
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
  return listLlmBatchJobs({ status: 'pending', order: 'asc' })
}

export async function listRecentLlmBatchJobs(limit = 20): Promise<LlmBatchJob[]> {
  return listLlmBatchJobs({ limit, order: 'desc' })
}

async function listLlmBatchJobs(opts: {
  status?: LlmBatchJobStatus
  limit?: number
  order: 'asc' | 'desc'
}): Promise<LlmBatchJob[]> {
  const db = getPool()
  if (!db) return []
  try {
    const params: unknown[] = []
    const where = opts.status ? `WHERE status = $${params.push(opts.status)}` : ''
    const limit = opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? `LIMIT $${params.push(Math.round(opts.limit))}`
      : ''
    const order = opts.order === 'asc' ? 'ASC' : 'DESC'
    const { rows } = await db.query<{
      job_name: string
      source: string
      status: string
      item_count: number
      custom_id_map: unknown
      submitted_at: Date | string
      checked_at: Date | string | null
      updated_at: Date | string
      error_message: string | null
    }>(
      `SELECT job_name, source, status, item_count, custom_id_map, submitted_at, checked_at, updated_at, error_message
       FROM llm_batch_jobs
       ${where}
       ORDER BY submitted_at ${order}
       ${limit}`,
      params,
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
      errorMessage: r.error_message,
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

export async function markLlmBatchJobResolved(
  jobName: string,
  status: Exclude<LlmBatchJobStatus, 'pending'>,
  checkedAt: string,
  errorMessage: string | null = null,
): Promise<void> {
  const db = getPool()
  if (!db) return
  try {
    await db.query(
      `UPDATE llm_batch_jobs
       SET status = $2, checked_at = $3, updated_at = now(), error_message = $4
       WHERE job_name = $1`,
      [jobName, status, checkedAt, errorMessage],
    )
  } catch (err) {
    console.warn(`[llm-batch-jobs] status update failed for ${jobName}: ${(err as Error).message}`)
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

/** Hard-delete helper kept for manual cleanup/tests. Normal poll completion
 *  uses markLlmBatchJobResolved() so /settings can show history. */
export async function deleteLlmBatchJob(jobName: string): Promise<void> {
  const db = getPool()
  if (!db) return
  try {
    await db.query('DELETE FROM llm_batch_jobs WHERE job_name = $1', [jobName])
  } catch (err) {
    console.warn(`[llm-batch-jobs] delete failed for ${jobName}: ${(err as Error).message}`)
  }
}
