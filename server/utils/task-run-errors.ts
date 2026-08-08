// Durable per-item error history for tracked tasks — complements
// task-runs.ts's lastWarning/lastError (a single string, overwritten every
// run). enrich.ts's runErrors array is truncated to 20 entries and only
// covers the run currently displayed in /settings; this table keeps every
// entry so a failure pattern is still visible after the next run overwrites
// lastWarning, or after a container restart wipes anything that only ever
// reached console.warn.

import { getPool } from './db'
import type { TrackedTask } from './task-runs'

const RETENTION_DAYS = 14

export interface TaskRunErrorEntry {
  platform?: string | null
  externalId?: string | null
  category: string
  message: string
}

export interface TaskRunError extends TaskRunErrorEntry {
  id: number
  task: string
  createdAt: string
}

/** Best-effort: a failure here must never mask the original error it's
 *  trying to record. */
export async function recordTaskRunError(task: TrackedTask, entry: TaskRunErrorEntry): Promise<void> {
  const db = getPool()
  if (!db) return
  try {
    await db.query(
      `INSERT INTO task_run_errors (task, platform, external_id, category, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [task, entry.platform ?? null, entry.externalId ?? null, entry.category, entry.message],
    )
    await db.query(
      `DELETE FROM task_run_errors WHERE task = $1 AND created_at < now() - interval '${RETENTION_DAYS} days'`,
      [task],
    )
  } catch (err) {
    console.warn(`[task-run-errors] record failed for ${task}: ${(err as Error).message}`)
  }
}

/** Cross-task — an auction's pipeline history spans enrich (crawl-side) and
 *  reprocess (LLM-side) errors alike. Uses
 *  idx_task_run_errors_platform_external_created. */
export async function listTaskRunErrorsForIdentity(platform: string, externalId: string, limit = 100): Promise<TaskRunError[]> {
  const db = getPool()
  if (!db) return []
  try {
    const { rows } = await db.query<{
      id: number
      task: string
      platform: string | null
      external_id: string | null
      category: string
      message: string
      created_at: string
    }>(
      `SELECT id, task, platform, external_id, category, message, created_at
       FROM task_run_errors WHERE platform = $1 AND external_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [platform, externalId, limit],
    )
    return rows.map((row) => ({
      id: row.id,
      task: row.task,
      platform: row.platform,
      externalId: row.external_id,
      category: row.category,
      message: row.message,
      createdAt: row.created_at,
    }))
  } catch (err) {
    console.warn(`[task-run-errors] list failed for ${platform}:${externalId}: ${(err as Error).message}`)
    return []
  }
}

export async function listRecentTaskRunErrors(task: TrackedTask, limit = 100): Promise<TaskRunError[]> {
  const db = getPool()
  if (!db) return []
  try {
    const { rows } = await db.query<{
      id: number
      task: string
      platform: string | null
      external_id: string | null
      category: string
      message: string
      created_at: string
    }>(
      `SELECT id, task, platform, external_id, category, message, created_at
       FROM task_run_errors WHERE task = $1 ORDER BY created_at DESC LIMIT $2`,
      [task, limit],
    )
    return rows.map((row) => ({
      id: row.id,
      task: row.task,
      platform: row.platform,
      externalId: row.external_id,
      category: row.category,
      message: row.message,
      createdAt: row.created_at,
    }))
  } catch (err) {
    console.warn(`[task-run-errors] list failed for ${task}: ${(err as Error).message}`)
    return []
  }
}
