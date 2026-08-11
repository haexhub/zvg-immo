// Records and aggregates the llm_usage_events log (server/db/schema/ops.ts)
// — the actual-spend counterpart to llm_batch_jobs' job-lifecycle tracking.
// One row per answered call (sync or one batch-job item). Recording is
// best-effort: a DB hiccup here must never fail the extraction/translation
// call that already happened, same posture as recordLlmBatchCapability in
// llm-batch-jobs.ts.

import { sql } from 'drizzle-orm'
import { llmUsageEvents } from '../db/schema'
import type { LlmUsage } from './extract/llm'
import { resolveCostUsd } from './extract/llm-pricing'
import { getDb, getPool } from './db'

export type LlmUsageTask = 'extraction' | 'translation' | 'place-name-translation'
export type LlmUsageExecutionMode = 'sync' | 'batch'

export interface RecordLlmUsageInput {
  task: LlmUsageTask
  executionMode: LlmUsageExecutionMode
  source: 'reprocess' | 'enrich' | 'admin-trial' | null
  provider: string
  model: string
  profileId: string | null
  platform: string | null
  externalId: string | null
  usage: LlmUsage | null
  status?: 'succeeded' | 'failed'
  errorMessage?: string | null
  durationMs?: number | null
  /** Set for a batch-job item — together with platform/externalId, its
   *  stable result identity. A retry after a later write in the same batch
   *  item fails (llm-batch-poll.ts) re-enters this with the same identity;
   *  the unique index + conflict-ignore below drops that duplicate instead
   *  of double-counting the call. Omitted (null) for sync calls, which have
   *  no such retry-replay and no identity to dedupe on. */
  batchJobName?: string | null
}

export async function recordLlmUsage(event: RecordLlmUsageInput): Promise<void> {
  const db = getDb()
  if (!db) return
  try {
    await db.insert(llmUsageEvents).values({
      task: event.task,
      executionMode: event.executionMode,
      source: event.source,
      provider: event.provider,
      model: event.model,
      profileId: event.profileId,
      platform: event.platform,
      externalId: event.externalId,
      inputTokens: event.usage?.inputTokens ?? null,
      outputTokens: event.usage?.outputTokens ?? null,
      costUsd: resolveCostUsd(event.model, event.usage),
      status: event.status ?? 'succeeded',
      errorMessage: event.errorMessage ?? null,
      durationMs: event.durationMs ?? null,
      batchJobName: event.batchJobName ?? null,
    }).onConflictDoNothing({
      target: [llmUsageEvents.batchJobName, llmUsageEvents.platform, llmUsageEvents.externalId],
      where: sql`${llmUsageEvents.batchJobName} is not null`,
    })
  } catch (err) {
    console.warn(`[llm-usage] record failed: ${(err as Error).message}`)
  }
}

export interface LlmCostBreakdownRow {
  task: string
  provider: string
  model: string
  profileId: string | null
  callCount: number
  inputTokens: number
  outputTokens: number
  /** Null when every call in this bucket was unpriced — see unpricedCallCount. */
  costUsd: number | null
  unpricedCallCount: number
}

export interface LlmCostDailyRow {
  day: string
  costUsd: number
  inputTokens: number
  outputTokens: number
}

export interface LlmCostOverview {
  windowDays: number
  totalCostUsd: number
  totalUnpricedCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  todayCostUsd: number
  breakdown: LlmCostBreakdownRow[]
  daily: LlmCostDailyRow[]
}

function emptyOverview(windowDays: number): LlmCostOverview {
  return {
    windowDays,
    totalCostUsd: 0,
    totalUnpricedCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    todayCostUsd: 0,
    breakdown: [],
    daily: [],
  }
}

/** Aggregates for the /settings cost card. Two grouped reads (breakdown +
 *  daily series) rather than one — the breakdown is grouped by
 *  task/provider/model/profile, the daily series by day, and combining both
 *  into a single GROUP BY would either duplicate rows or lose a dimension. */
export async function readLlmCostOverview(windowDays = 30): Promise<LlmCostOverview> {
  const db = getPool()
  if (!db) return emptyOverview(windowDays)
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()

  const [breakdownResult, dailyResult] = await Promise.all([
    db.query<{
      task: string
      provider: string
      model: string
      profile_id: string | null
      call_count: string
      input_tokens: string
      output_tokens: string
      cost_usd: number | null
      unpriced_call_count: string
    }>(
      `SELECT task, provider, model, profile_id,
              count(*) AS call_count,
              coalesce(sum(input_tokens), 0) AS input_tokens,
              coalesce(sum(output_tokens), 0) AS output_tokens,
              sum(cost_usd) AS cost_usd,
              count(*) FILTER (WHERE cost_usd IS NULL) AS unpriced_call_count
       FROM llm_usage_events
       WHERE occurred_at >= $1::timestamptz
       GROUP BY task, provider, model, profile_id
       ORDER BY cost_usd DESC NULLS LAST, call_count DESC`,
      [cutoff],
    ),
    db.query<{ day: string; cost_usd: number | null; input_tokens: string; output_tokens: string }>(
      `SELECT to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') AS day,
              coalesce(sum(cost_usd), 0) AS cost_usd,
              coalesce(sum(input_tokens), 0) AS input_tokens,
              coalesce(sum(output_tokens), 0) AS output_tokens
       FROM llm_usage_events
       WHERE occurred_at >= $1::timestamptz
       GROUP BY 1
       ORDER BY 1`,
      [cutoff],
    ),
  ])

  const breakdown: LlmCostBreakdownRow[] = breakdownResult.rows.map((row) => ({
    task: row.task,
    provider: row.provider,
    model: row.model,
    profileId: row.profile_id,
    callCount: Number(row.call_count),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    costUsd: row.cost_usd,
    unpricedCallCount: Number(row.unpriced_call_count),
  }))
  const daily: LlmCostDailyRow[] = dailyResult.rows.map((row) => ({
    day: row.day,
    costUsd: row.cost_usd ?? 0,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
  }))

  const today = new Date().toISOString().slice(0, 10)
  return {
    windowDays,
    totalCostUsd: breakdown.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
    totalUnpricedCalls: breakdown.reduce((sum, row) => sum + row.unpricedCallCount, 0),
    totalInputTokens: breakdown.reduce((sum, row) => sum + row.inputTokens, 0),
    totalOutputTokens: breakdown.reduce((sum, row) => sum + row.outputTokens, 0),
    todayCostUsd: daily.find((row) => row.day === today)?.costUsd ?? 0,
    breakdown,
    daily,
  }
}
