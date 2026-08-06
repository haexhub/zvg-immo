// Tracks whether a scheduled Nitro task (`enrich`, `reprocess` or
// `external-enrichment`) is running right now and what its last run produced —
// each task's own exclusivity guard is in-memory only, so /settings had no way
// to show whether the pipeline is alive or stuck. This is also what makes a
// detached (fire-and-forget) trigger safe: the run's failure lands here instead
// of disappearing with the promise. Same app_settings KV + graceful
// in-memory-fallback pattern as llm-batch-jobs.ts's recordLlmBatchCapability.

import { getPool } from './db'

export type TrackedTask = 'enrich' | 'reprocess' | 'external-enrichment' | 'offload-images'

// enrich.ts (crawl/archive) and reprocess.ts (extraction) report differently
// shaped, purely-numeric result summaries — kept generic here rather than a
// fixed key list per task, so this file doesn't need to know either task's
// exact shape.
export type TaskRunSummary = Record<string, number>

export interface TaskRunStatus {
  status: 'idle' | 'running'
  startedAt: string | null
  finishedAt: string | null
  lastResult: TaskRunSummary | null
  lastError: string | null
  lastWarning: string | null
  /** Last LLM provider request failure (network/HTTP error, e.g. a 403 from
   *  a misconfigured key) from the current or most recent run. Distinct from
   *  `lastError` (the whole task throwing) and `lastWarning` (a rate-limit
   *  backoff) — a run can finish "successfully" while every individual LLM
   *  call failed, which is exactly what this field is for. Null when the
   *  run's LLM calls (if any) haven't failed. */
  lastLlmError: string | null
  /** Numeric progress snapshot of the run currently in flight — null when
   *  idle or before the first progress report of a fresh run. */
  progress: TaskRunSummary | null
  /** Same numeric snapshot, broken down per country (ISO-2, lowercase) —
   *  lets /settings show which countries are done vs. still in flight
   *  instead of just the aggregate. Unlike `progress`, this is neither
   *  cleared by recordTaskRunStart/End nor replaced wholesale: entries are
   *  merged per country, so each country keeps its last reported state until
   *  a run that actually covers it reports a new one. That matters for the
   *  country-scoped manual triggers in /settings — crawling one country must
   *  not blank out every other country's last known state. Null when the
   *  task has never reported per-country progress (e.g. old data from before
   *  this field existed). */
  progressByCountry: Record<string, TaskRunSummary> | null
}

const TASK_RUN_STATUS_KEY = 'task_run_status'

const IDLE_STATUS: TaskRunStatus = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  lastError: null,
  lastWarning: null,
  lastLlmError: null,
  progress: null,
  progressByCountry: null,
}

// Per-task last progress-write timestamp (ms), so a fast-moving loop (e.g. a
// 300-item reprocess run) doesn't turn every processed item into its own
// Postgres write.
const PROGRESS_THROTTLE_MS = 1500
const lastProgressWriteAt = new Map<TrackedTask, number>()

// Serializes start/progress/end's read-modify-write per task. Without this, a
// late (unawaited) recordTaskRunProgress read issued just before
// recordTaskRunEnd — e.g. the last iteration of enrich's per-item loop — could
// still be mid-flight when recordTaskRunEnd's write lands, then overwrite it
// with the stale pre-completion status once it finally resolves, leaving
// /settings polling forever. Queuing by call order (not completion order)
// guarantees an earlier call's write always lands before a later call's
// read-modify-write begins.
const taskQueues = new Map<TrackedTask, Promise<unknown>>()

function enqueue<T>(task: TrackedTask, fn: () => Promise<T>): Promise<T> {
  const prev = taskQueues.get(task) ?? Promise.resolve()
  const result = prev.then(fn, fn)
  taskQueues.set(task, result.catch(() => {}))
  return result
}

let memoryTaskRunStatus: Record<string, TaskRunStatus> = {}

function coerceSummary(value: unknown): TaskRunSummary | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const out: TaskRunSummary = {}
  for (const [key, entryValue] of Object.entries(v)) {
    if (typeof entryValue !== 'number' || !Number.isFinite(entryValue)) return null
    out[key] = entryValue
  }
  return out
}

function coerceProgressByCountry(value: unknown): Record<string, TaskRunSummary> | null {
  if (!value || typeof value !== 'object') return null
  const out: Record<string, TaskRunSummary> = {}
  for (const [country, entry] of Object.entries(value as Record<string, unknown>)) {
    const summary = coerceSummary(entry)
    if (summary) out[country] = summary
  }
  return out
}

function coerceTaskRunStatus(value: unknown): TaskRunStatus {
  if (!value || typeof value !== 'object') return IDLE_STATUS
  const v = value as Record<string, unknown>
  return {
    status: v.status === 'running' ? 'running' : 'idle',
    startedAt: typeof v.startedAt === 'string' && v.startedAt ? v.startedAt : null,
    finishedAt: typeof v.finishedAt === 'string' && v.finishedAt ? v.finishedAt : null,
    lastResult: coerceSummary(v.lastResult),
    lastError: typeof v.lastError === 'string' && v.lastError ? v.lastError : null,
    lastWarning: typeof v.lastWarning === 'string' && v.lastWarning ? v.lastWarning : null,
    lastLlmError: typeof v.lastLlmError === 'string' && v.lastLlmError ? v.lastLlmError : null,
    progress: coerceSummary(v.progress),
    progressByCountry: coerceProgressByCountry(v.progressByCountry),
  }
}

async function readAllTaskRunStatuses(): Promise<Record<string, TaskRunStatus>> {
  const db = getPool()
  if (!db) return memoryTaskRunStatus
  try {
    const { rows } = await db.query<{ value: unknown }>(
      'SELECT value FROM app_settings WHERE key = $1',
      [TASK_RUN_STATUS_KEY],
    )
    const raw = rows[0]?.value
    if (!raw || typeof raw !== 'object') return {}
    const out: Record<string, TaskRunStatus> = {}
    for (const [task, entry] of Object.entries(raw as Record<string, unknown>)) {
      out[task] = coerceTaskRunStatus(entry)
    }
    return out
  } catch (err) {
    console.warn(`[task-runs] read failed: ${(err as Error).message}`)
    return memoryTaskRunStatus
  }
}

async function writeTaskRunStatus(task: TrackedTask, next: TaskRunStatus): Promise<void> {
  const db = getPool()
  if (!db) {
    memoryTaskRunStatus = { ...memoryTaskRunStatus, [task]: next }
    return
  }
  try {
    // Atomic per-task merge, same rationale as recordLlmBatchCapability: avoid
    // a read-then-overwrite race between concurrent tracked tasks.
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, jsonb_build_object($2::text, $3::jsonb), now())
       ON CONFLICT (key) DO UPDATE SET
         value = app_settings.value || jsonb_build_object($2::text, $3::jsonb),
         updated_at = now()`,
      [TASK_RUN_STATUS_KEY, task, JSON.stringify(next)],
    )
  } catch (err) {
    console.warn(`[task-runs] write failed for ${task}: ${(err as Error).message}`)
    memoryTaskRunStatus = { ...memoryTaskRunStatus, [task]: next }
  }
}

export async function getTaskRunStatus(task: TrackedTask): Promise<TaskRunStatus> {
  const all = await readAllTaskRunStatuses()
  return all[task] ?? IDLE_STATUS
}

export async function recordTaskRunStart(task: TrackedTask): Promise<void> {
  lastProgressWriteAt.delete(task)
  await enqueue(task, async () => {
    const current = await getTaskRunStatus(task)
    await writeTaskRunStatus(task, {
      ...current,
      status: 'running',
      startedAt: new Date().toISOString(),
      lastError: null,
      lastWarning: null,
      lastLlmError: null,
      progress: null,
    })
  })
}

export async function recordTaskRunEnd(
  task: TrackedTask,
  outcome: { result: TaskRunSummary; warning?: string | null; llmError?: string | null } | { error: string },
): Promise<void> {
  lastProgressWriteAt.delete(task)
  await enqueue(task, async () => {
    const current = await getTaskRunStatus(task)
    await writeTaskRunStatus(task, {
      ...current,
      status: 'idle',
      finishedAt: new Date().toISOString(),
      lastResult: 'result' in outcome ? outcome.result : current.lastResult,
      lastError: 'error' in outcome ? outcome.error : null,
      lastWarning: 'result' in outcome ? outcome.warning ?? null : null,
      lastLlmError: 'result' in outcome ? (outcome.llmError ?? null) : current.lastLlmError,
      progress: null,
    })
  })
}

/** Updates only `progress`/`progressByCountry`, leaving
 *  `status`/`startedAt`/`lastResult` untouched — for a long-running loop
 *  (crawlAll's regions, enrich's per-auction worker, reprocess's
 *  per-candidate loop) to report how far along it is while it's still
 *  running. Throttled per task so a fast loop doesn't turn every item into
 *  its own Postgres write; queued behind start/end (see `enqueue`) so a
 *  throttled-through call can never land after the run's own end write.
 *
 *  `flush` bypasses the throttle. A run's *last* progress report is the one
 *  that stays visible in /settings after it finishes (recordTaskRunEnd
 *  clears `progress` but keeps `progressByCountry`), so it must not be the
 *  one the throttle happens to swallow — otherwise a completed run is left
 *  showing e.g. 260/300 forever. Callers use it exactly once, after their
 *  loop. */
export async function recordTaskRunProgress(
  task: TrackedTask,
  progress: TaskRunSummary,
  extra: {
    lastLlmError?: string | null
    progressByCountry?: Record<string, TaskRunSummary>
    flush?: boolean
  } = {},
): Promise<void> {
  const now = Date.now()
  const last = lastProgressWriteAt.get(task) ?? 0
  if (!extra.flush && now - last < PROGRESS_THROTTLE_MS) return
  lastProgressWriteAt.set(task, now)
  await enqueue(task, async () => {
    const current = await getTaskRunStatus(task)
    await writeTaskRunStatus(task, {
      ...current,
      progress,
      ...(extra.progressByCountry !== undefined
        ? { progressByCountry: { ...current.progressByCountry, ...extra.progressByCountry } }
        : {}),
      ...(extra.lastLlmError !== undefined ? { lastLlmError: extra.lastLlmError } : {}),
    })
  })
}
