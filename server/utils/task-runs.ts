// Tracks whether a scheduled Nitro task (`enrich` or `reprocess`) is running
// right now and what its last run produced — each task's own `running` guard
// is in-memory only, so /settings had no way to show whether the pipeline is
// alive or stuck. Same app_settings KV + graceful in-memory-fallback pattern
// as llm-batch-jobs.ts's recordLlmBatchCapability/getAllLlmBatchCapabilities.

import { getPool } from './db'

export type TrackedTask = 'enrich' | 'reprocess'

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
}

const TASK_RUN_STATUS_KEY = 'task_run_status'

const IDLE_STATUS: TaskRunStatus = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  lastError: null,
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

function coerceTaskRunStatus(value: unknown): TaskRunStatus {
  if (!value || typeof value !== 'object') return IDLE_STATUS
  const v = value as Record<string, unknown>
  return {
    status: v.status === 'running' ? 'running' : 'idle',
    startedAt: typeof v.startedAt === 'string' && v.startedAt ? v.startedAt : null,
    finishedAt: typeof v.finishedAt === 'string' && v.finishedAt ? v.finishedAt : null,
    lastResult: coerceSummary(v.lastResult),
    lastError: typeof v.lastError === 'string' && v.lastError ? v.lastError : null,
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
  const current = await getTaskRunStatus(task)
  await writeTaskRunStatus(task, {
    ...current,
    status: 'running',
    startedAt: new Date().toISOString(),
  })
}

export async function recordTaskRunEnd(
  task: TrackedTask,
  outcome: { result: TaskRunSummary } | { error: string },
): Promise<void> {
  const current = await getTaskRunStatus(task)
  await writeTaskRunStatus(task, {
    ...current,
    status: 'idle',
    finishedAt: new Date().toISOString(),
    lastResult: 'result' in outcome ? outcome.result : current.lastResult,
    lastError: 'error' in outcome ? outcome.error : null,
  })
}
