// Tracks in-flight LLM Batch API jobs (server/utils/extract/*-batch.ts)
// so llm-batch-poll.ts knows what to check and enrich.ts/reprocess.ts can
// avoid double-submitting while a job is still open (see
// auction_fetch_state.llm_batch_job). No in-process memoization —
// this table has too few rows for caching to be worth the invalidation
// complexity; a live read per poll tick is simpler. Same graceful-no-op
// getDb() returns null without NUXT_DATABASE_URL.

import { asc, desc, eq, sql } from 'drizzle-orm'
import { appSettings, llmBatchJobs } from '../db/schema'
import { getDb } from './db'

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
  /** The LlmConfig actually used at submit time — null for rows written
   *  before these columns existed. Read back at poll/merge time
   *  (llm-batch-poll.ts) instead of guessing from the poll-time config,
   *  which can point at a different model by the time a batch (up to 48h)
   *  completes — see server/utils/llm-usage.ts. */
  provider: string | null
  model: string | null
  profileId: string | null
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
  // 'config': synthesized from a static gate (e.g. Gemini's free-tier check)
  // rather than a real submit attempt — see isGeminiBatchTierPaid() and
  // server/api/settings/llm-batch-jobs.get.ts.
  source: 'enrich' | 'reprocess' | 'config'
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
  const db = getDb()
  if (!db) {
    memoryGeminiQuotaUsage = coerceGeminiQuotaUsage(memoryGeminiQuotaUsage, day)
    return memoryGeminiQuotaUsage
  }
  try {
    const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, GEMINI_BATCH_QUOTA_KEY))
    return coerceGeminiQuotaUsage(row?.value, day)
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
  const db = getDb()
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
    await db.execute(sql`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (
        ${GEMINI_BATCH_QUOTA_KEY},
        jsonb_build_object(
          'day', ${day}::text,
          'jobs', ${safeDelta.jobs}::integer,
          'items', ${safeDelta.items}::integer,
          'estimatedTokens', ${safeDelta.estimatedTokens}::integer,
          'backoffUntil', NULL::text
        ),
        now()
      )
      ON CONFLICT (key) DO UPDATE SET
        value = CASE
          WHEN app_settings.value->>'day' = ${day}::text THEN jsonb_build_object(
            'day', ${day}::text,
            'jobs', (CASE WHEN app_settings.value->>'jobs' ~ '^[0-9]+$' THEN (app_settings.value->>'jobs')::integer ELSE 0 END) + ${safeDelta.jobs}::integer,
            'items', (CASE WHEN app_settings.value->>'items' ~ '^[0-9]+$' THEN (app_settings.value->>'items')::integer ELSE 0 END) + ${safeDelta.items}::integer,
            'estimatedTokens', (CASE WHEN app_settings.value->>'estimatedTokens' ~ '^[0-9]+$' THEN (app_settings.value->>'estimatedTokens')::integer ELSE 0 END) + ${safeDelta.estimatedTokens}::integer,
            'backoffUntil', NULLIF(app_settings.value->>'backoffUntil', '')
          )
          ELSE jsonb_build_object(
            'day', ${day}::text,
            'jobs', ${safeDelta.jobs}::integer,
            'items', ${safeDelta.items}::integer,
            'estimatedTokens', ${safeDelta.estimatedTokens}::integer,
            'backoffUntil', NULL::text
          )
        END,
        updated_at = now()
    `)
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
  const db = getDb()
  if (!db) {
    const current = await readGeminiBatchQuotaUsage(day)
    const next: GeminiBatchQuotaUsage = { ...current, backoffUntil }
    memoryGeminiQuotaUsage = next
    return
  }
  try {
    await db.execute(sql`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (
        ${GEMINI_BATCH_QUOTA_KEY},
        jsonb_build_object('day', ${day}::text, 'jobs', 0, 'items', 0, 'estimatedTokens', 0, 'backoffUntil', ${backoffUntil}::text),
        now()
      )
      ON CONFLICT (key) DO UPDATE SET
        value = CASE
          WHEN app_settings.value->>'day' = ${day}::text THEN jsonb_build_object(
            'day', ${day}::text,
            'jobs', CASE WHEN app_settings.value->>'jobs' ~ '^[0-9]+$' THEN (app_settings.value->>'jobs')::integer ELSE 0 END,
            'items', CASE WHEN app_settings.value->>'items' ~ '^[0-9]+$' THEN (app_settings.value->>'items')::integer ELSE 0 END,
            'estimatedTokens', CASE WHEN app_settings.value->>'estimatedTokens' ~ '^[0-9]+$' THEN (app_settings.value->>'estimatedTokens')::integer ELSE 0 END,
            'backoffUntil', ${backoffUntil}::text
          )
          ELSE jsonb_build_object('day', ${day}::text, 'jobs', 0, 'items', 0, 'estimatedTokens', 0, 'backoffUntil', ${backoffUntil}::text)
        END,
        updated_at = now()
    `)
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
  if (v.source !== 'enrich' && v.source !== 'reprocess' && v.source !== 'config') return null
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
  const db = getDb()
  if (!db) return memoryLlmBatchCapability
  try {
    const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, LLM_BATCH_CAPABILITY_KEY))
    return coerceLlmBatchCapabilityMap(row?.value)
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
  const db = getDb()
  if (!db) {
    memoryLlmBatchCapability = { ...memoryLlmBatchCapability, [provider]: next }
    return
  }
  try {
    // Atomic per-provider merge (no read-then-write) — enrich.ts and
    // reprocess.ts run as independent background tasks that can submit
    // concurrently, and a read-then-overwrite here could let one call's
    // stale snapshot clobber another provider's just-written capability.
    await db.execute(sql`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (${LLM_BATCH_CAPABILITY_KEY}, jsonb_build_object(${provider}::text, ${JSON.stringify(next)}::jsonb), now())
      ON CONFLICT (key) DO UPDATE SET
        value = app_settings.value || jsonb_build_object(${provider}::text, ${JSON.stringify(next)}::jsonb),
        updated_at = now()
    `)
  } catch (err) {
    console.warn(`[llm-batch-jobs] capability write failed for ${provider}: ${(err as Error).message}`)
    memoryLlmBatchCapability = { ...memoryLlmBatchCapability, [provider]: next }
  }
}

export async function withGeminiBatchQuotaLock<T>(fn: () => Promise<T>): Promise<T> {
  const db = getDb()
  if (!db) return withMemoryGeminiBatchQuotaLock(fn)
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${GEMINI_BATCH_QUOTA_KEY}))`)
    return fn()
  })
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

/** Returns whether the row was recorded, so the caller can
 *  treat a failed insert as a failed submission instead of returning a job
 *  name the poller will never see. */
export async function insertLlmBatchJob(job: {
  jobName: string
  source: 'enrich' | 'reprocess'
  itemCount: number
  customIdMap?: Record<string, string>
  provider?: string
  model?: string
  profileId?: string | null
}): Promise<boolean> {
  const db = getDb()
  if (!db) return true
  try {
    await db.insert(llmBatchJobs).values({
      jobName: job.jobName,
      source: job.source,
      itemCount: job.itemCount,
      customIdMap: job.customIdMap ?? {},
      provider: job.provider ?? null,
      model: job.model ?? null,
      profileId: job.profileId ?? null,
    })
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
  const db = getDb()
  if (!db) return []
  try {
    const orderFn = opts.order === 'asc' ? asc : desc
    const baseQuery = db.select({
      jobName: llmBatchJobs.jobName,
      source: llmBatchJobs.source,
      status: llmBatchJobs.status,
      itemCount: llmBatchJobs.itemCount,
      customIdMap: llmBatchJobs.customIdMap,
      submittedAt: llmBatchJobs.submittedAt,
      checkedAt: llmBatchJobs.checkedAt,
      updatedAt: llmBatchJobs.updatedAt,
      errorMessage: llmBatchJobs.errorMessage,
      provider: llmBatchJobs.provider,
      model: llmBatchJobs.model,
      profileId: llmBatchJobs.profileId,
    })
      .from(llmBatchJobs)
      .where(opts.status ? eq(llmBatchJobs.status, opts.status) : undefined)
      .orderBy(orderFn(llmBatchJobs.submittedAt))
    const rows = opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? await baseQuery.limit(Math.round(opts.limit))
      : await baseQuery
    return rows.map((r) => ({
      jobName: r.jobName,
      source: r.source as 'enrich' | 'reprocess',
      status: r.status as LlmBatchJobStatus,
      itemCount: r.itemCount,
      customIdMap: isStringMap(r.customIdMap) ? r.customIdMap : {},
      submittedAt: toIso(r.submittedAt),
      checkedAt: r.checkedAt == null ? null : toIso(r.checkedAt),
      updatedAt: toIso(r.updatedAt),
      errorMessage: r.errorMessage,
      provider: r.provider,
      model: r.model,
      profileId: r.profileId,
    }))
  } catch (err) {
    console.warn(`[llm-batch-jobs] list failed: ${(err as Error).message}`)
    return []
  }
}

export async function markLlmBatchJobChecked(jobName: string, checkedAt: string): Promise<void> {
  const db = getDb()
  if (!db) return
  try {
    await db.update(llmBatchJobs)
      .set({ checkedAt: new Date(checkedAt), updatedAt: sql`now()` })
      .where(eq(llmBatchJobs.jobName, jobName))
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
  const db = getDb()
  if (!db) return
  try {
    await db.update(llmBatchJobs)
      .set({ status, checkedAt: new Date(checkedAt), updatedAt: sql`now()`, errorMessage })
      .where(eq(llmBatchJobs.jobName, jobName))
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
  const db = getDb()
  if (!db) return
  try {
    await db.delete(llmBatchJobs).where(eq(llmBatchJobs.jobName, jobName))
  } catch (err) {
    console.warn(`[llm-batch-jobs] delete failed for ${jobName}: ${(err as Error).message}`)
  }
}
