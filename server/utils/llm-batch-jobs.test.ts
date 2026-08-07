import { describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'

vi.mock('./db', () => ({ getDb: vi.fn() }))

function queryText(queryArg: unknown): string {
  return typeof queryArg === 'string' ? queryArg : (queryArg as { text: string }).text
}

function makeFakePool() {
  const settings = new Map<string, unknown>()
  const rows: Array<{
    job_name: string
    source: string
    status: string
    item_count: number
    custom_id_map: Record<string, string>
    submitted_at: string
    checked_at: string | null
    updated_at: string
    error_message: string | null
  }> = []
  const query = vi.fn(async (queryArg: unknown, params: unknown[] = []) => {
    const text = queryText(queryArg)
    const n = text.replace(/\s+/g, ' ').trim().toLowerCase()
    if (n.startsWith('insert into "llm_batch_jobs"')) {
      rows.push({
        job_name: params[0] as string,
        source: params[1] as string,
        status: 'pending',
        item_count: params[2] as number,
        custom_id_map: params[3] ? JSON.parse(params[3] as string) : {},
        submitted_at: '2026-07-26T18:00:00.000Z',
        checked_at: null,
        updated_at: '2026-07-26T18:00:00.000Z',
        error_message: null,
      })
      return { rows: [], rowCount: 1 }
    }
    if (n.startsWith('select "job_name", "source", "status", "item_count", "custom_id_map", "submitted_at", "checked_at", "updated_at"')) {
      const status = n.includes('where "llm_batch_jobs"."status" =') ? params[0] as string : undefined
      const limit = typeof params.at(-1) === 'number' ? params.at(-1) as number : undefined
      const selected = status ? rows.filter((r) => r.status === status) : [...rows]
      const ordered = n.includes('order by "llm_batch_jobs"."submitted_at" desc') ? [...selected].reverse() : selected
      const limited = limit ? ordered.slice(0, limit) : ordered
      // array-mode rows, in the select's field order.
      return {
        rows: limited.map((r) => [
          r.job_name,
          r.source,
          r.status,
          r.item_count,
          r.custom_id_map,
          r.submitted_at,
          r.checked_at,
          r.updated_at,
          r.error_message,
        ]),
        rowCount: limited.length,
      }
    }
    if (n.startsWith('delete from "llm_batch_jobs"')) {
      const idx = rows.findIndex((r) => r.job_name === params[0])
      if (idx >= 0) rows.splice(idx, 1)
      return { rows: [], rowCount: idx >= 0 ? 1 : 0 }
    }
    if (n.startsWith('update "llm_batch_jobs" set "checked_at"')) {
      const row = rows.find((r) => r.job_name === params[1])
      if (row) {
        row.checked_at = params[0] as string
        row.updated_at = params[0] as string
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }
    if (n.startsWith('update "llm_batch_jobs" set "status"')) {
      const row = rows.find((r) => r.job_name === params[3])
      if (row) {
        row.status = params[0] as string
        row.checked_at = params[1] as string
        row.updated_at = params[1] as string
        row.error_message = (params[2] as string | null | undefined) ?? null
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }
    if (n.startsWith('select "value" from "app_settings"')) {
      const value = settings.get(params[0] as string)
      return { rows: value === undefined ? [] : [[value]], rowCount: value === undefined ? 0 : 1 }
    }
    if (n.includes('value || jsonb_build_object')) {
      // Atomic per-provider capability merge (recordLlmBatchCapability):
      // params = [key, provider, jsonValue, provider, jsonValue] (Drizzle
      // repeats the interpolated values for the INSERT and the ON CONFLICT
      // SET clause separately).
      const key = params[0] as string
      const provider = params[1] as string
      const value = typeof params[2] === 'string' ? JSON.parse(params[2] as string) : params[2]
      const current = (settings.get(key) as Record<string, unknown> | undefined) ?? {}
      settings.set(key, { ...current, [provider]: value })
      return { rows: [], rowCount: 1 }
    }
    if (n.startsWith('insert into app_settings') && !n.includes('jsonb_build_object')) {
      // Generic key/value upsert: params = [key, jsonValue].
      const key = params[0] as string
      const value = typeof params[1] === 'string' ? JSON.parse(params[1] as string) : params[1]
      settings.set(key, value)
      return { rows: [], rowCount: 1 }
    }
    if (n.startsWith('insert into app_settings')) {
      const key = params[0] as string
      const day = params[1] as string
      const current = settings.get(key) as
        | { day?: string; jobs?: number; items?: number; estimatedTokens?: number; backoffUntil?: string | null }
        | undefined
      if (n.includes("'backoffuntil', null::text")) {
        const deltaJobs = params[2] as number
        const deltaItems = params[3] as number
        const deltaEstimatedTokens = params[4] as number
        settings.set(
          key,
          current?.day === day
            ? {
                day,
                jobs: (current.jobs ?? 0) + deltaJobs,
                items: (current.items ?? 0) + deltaItems,
                estimatedTokens: (current.estimatedTokens ?? 0) + deltaEstimatedTokens,
                backoffUntil: current.backoffUntil ?? null,
              }
            : {
                day,
                jobs: deltaJobs,
                items: deltaItems,
                estimatedTokens: deltaEstimatedTokens,
                backoffUntil: null,
              },
        )
      } else {
        const backoffUntil = params[2] as string
        settings.set(
          key,
          current?.day === day
            ? {
                day,
                jobs: current.jobs ?? 0,
                items: current.items ?? 0,
                estimatedTokens: current.estimatedTokens ?? 0,
                backoffUntil,
              }
            : { day, jobs: 0, items: 0, estimatedTokens: 0, backoffUntil },
        )
      }
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${text}`)
  })
  function MockPool() {}
  const pgPool = Object.assign(new (MockPool as unknown as new () => object)(), { query })
  return { query, rows, settings, pool: drizzle(pgPool as never) }
}

describe('llm-batch-jobs', () => {
  it('is a no-op everywhere without a configured pool', async () => {
    const { getDb } = await import('./db')
    vi.mocked(getDb).mockReturnValue(null)
    const { insertLlmBatchJob, listPendingLlmBatchJobs, deleteLlmBatchJob } = await import('./llm-batch-jobs')

    await insertLlmBatchJob({ jobName: 'batches/1', source: 'enrich', itemCount: 5 })
    await expect(listPendingLlmBatchJobs()).resolves.toEqual([])
    await expect(deleteLlmBatchJob('batches/1')).resolves.toBeUndefined()
  })

  it('inserts a job and lists it as pending', async () => {
    const { getDb } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getDb).mockReturnValue(pool.pool as never)
    const { insertLlmBatchJob, listPendingLlmBatchJobs } = await import('./llm-batch-jobs')

    await insertLlmBatchJob({ jobName: 'batches/abc', source: 'reprocess', itemCount: 3 })
    const pending = await listPendingLlmBatchJobs()

    expect(pending).toEqual([
      {
        jobName: 'batches/abc',
        source: 'reprocess',
        status: 'pending',
        itemCount: 3,
        customIdMap: {},
        submittedAt: '2026-07-26T18:00:00.000Z',
        checkedAt: null,
        updatedAt: '2026-07-26T18:00:00.000Z',
        errorMessage: null,
      },
    ])
  })

  it('persists and returns an Anthropic custom_id map', async () => {
    const { getDb } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getDb).mockReturnValue(pool.pool as never)
    const { insertLlmBatchJob, listPendingLlmBatchJobs } = await import('./llm-batch-jobs')

    await insertLlmBatchJob({
      jobName: 'msgbatch_abc',
      source: 'enrich',
      itemCount: 1,
      customIdMap: { zvg_0_hash: 'zvg-portal:7265' },
    })

    await expect(listPendingLlmBatchJobs()).resolves.toEqual([
      {
        jobName: 'msgbatch_abc',
        source: 'enrich',
        status: 'pending',
        itemCount: 1,
        customIdMap: { zvg_0_hash: 'zvg-portal:7265' },
        submittedAt: '2026-07-26T18:00:00.000Z',
        checkedAt: null,
        updatedAt: '2026-07-26T18:00:00.000Z',
        errorMessage: null,
      },
    ])
  })

  it('deletes a job, removing it from the pending list', async () => {
    const { getDb } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getDb).mockReturnValue(pool.pool as never)
    const { insertLlmBatchJob, listPendingLlmBatchJobs, deleteLlmBatchJob } = await import('./llm-batch-jobs')

    await insertLlmBatchJob({ jobName: 'batches/abc', source: 'enrich', itemCount: 3 })
    await deleteLlmBatchJob('batches/abc')

    await expect(listPendingLlmBatchJobs()).resolves.toEqual([])
  })

  it('marks a job resolved and keeps it in recent history', async () => {
    const { getDb } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getDb).mockReturnValue(pool.pool as never)
    const { insertLlmBatchJob, listPendingLlmBatchJobs, listRecentLlmBatchJobs, markLlmBatchJobResolved } = await import('./llm-batch-jobs')

    await insertLlmBatchJob({ jobName: 'batches/abc', source: 'enrich', itemCount: 3 })
    await markLlmBatchJobResolved('batches/abc', 'succeeded', '2026-07-27T12:00:00.000Z')

    await expect(listPendingLlmBatchJobs()).resolves.toEqual([])
    await expect(listRecentLlmBatchJobs()).resolves.toEqual([
      expect.objectContaining({
        jobName: 'batches/abc',
        status: 'succeeded',
        checkedAt: '2026-07-27T12:00:00.000Z',
      }),
    ])
  })

  it('updates checked_at for a pending job', async () => {
    const { getDb } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getDb).mockReturnValue(pool.pool as never)
    const { insertLlmBatchJob, listPendingLlmBatchJobs, markLlmBatchJobChecked } = await import('./llm-batch-jobs')

    await insertLlmBatchJob({ jobName: 'batches/abc', source: 'enrich', itemCount: 3 })
    await markLlmBatchJobChecked('batches/abc', '2026-07-27T12:00:00.000Z')

    await expect(listPendingLlmBatchJobs()).resolves.toEqual([
      expect.objectContaining({
        jobName: 'batches/abc',
        checkedAt: '2026-07-27T12:00:00.000Z',
      }),
    ])
  })

  it('records Gemini batch quota usage per UTC day', async () => {
    const { getDb } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getDb).mockReturnValue(pool.pool as never)
    const { readGeminiBatchQuotaUsage, recordGeminiBatchQuotaUsage, setGeminiBatchQuotaBackoff } = await import('./llm-batch-jobs')

    await expect(readGeminiBatchQuotaUsage('2026-07-27')).resolves.toEqual({
      day: '2026-07-27',
      jobs: 0,
      items: 0,
      estimatedTokens: 0,
      backoffUntil: null,
    })

    await recordGeminiBatchQuotaUsage('2026-07-27', { jobs: 1, items: 5, estimatedTokens: 12_000 })
    await setGeminiBatchQuotaBackoff('2026-07-27', '2026-07-28T00:00:00.000Z')

    await expect(readGeminiBatchQuotaUsage('2026-07-27')).resolves.toEqual({
      day: '2026-07-27',
      jobs: 1,
      items: 5,
      estimatedTokens: 12_000,
      backoffUntil: '2026-07-28T00:00:00.000Z',
    })
    await expect(readGeminiBatchQuotaUsage('2026-07-28')).resolves.toEqual({
      day: '2026-07-28',
      jobs: 0,
      items: 0,
      estimatedTokens: 0,
      backoffUntil: null,
    })
  })

  it('marks a job resolved with its error message and surfaces it in history', async () => {
    const { getDb } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getDb).mockReturnValue(pool.pool as never)
    const { insertLlmBatchJob, listRecentLlmBatchJobs, markLlmBatchJobResolved } = await import('./llm-batch-jobs')

    await insertLlmBatchJob({ jobName: 'batches/abc', source: 'enrich', itemCount: 3 })
    await markLlmBatchJobResolved(
      'batches/abc',
      'failed',
      '2026-07-27T12:00:00.000Z',
      'FAILED_PRECONDITION: Precondition check failed.',
    )

    await expect(listRecentLlmBatchJobs()).resolves.toEqual([
      expect.objectContaining({
        jobName: 'batches/abc',
        status: 'failed',
        errorMessage: 'FAILED_PRECONDITION: Precondition check failed.',
      }),
    ])
  })

  it('tracks per-provider batch capability, defaulting to unset without a configured pool', async () => {
    const { getDb } = await import('./db')
    vi.mocked(getDb).mockReturnValue(null)
    const { getLlmBatchCapability, getAllLlmBatchCapabilities, recordLlmBatchCapability } = await import('./llm-batch-jobs')

    await expect(getLlmBatchCapability('gemini-native')).resolves.toBeNull()

    await recordLlmBatchCapability('gemini-native', {
      ok: false,
      message: 'FAILED_PRECONDITION: Precondition check failed.',
      source: 'enrich',
    })

    const capability = await getLlmBatchCapability('gemini-native')
    expect(capability).toMatchObject({ ok: false, message: 'FAILED_PRECONDITION: Precondition check failed.', source: 'enrich' })
    expect(typeof capability?.checkedAt).toBe('string')
    await expect(getAllLlmBatchCapabilities()).resolves.toEqual({ 'gemini-native': capability })
  })

  it('persists batch capability per provider without clobbering other providers', async () => {
    const { getDb } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getDb).mockReturnValue(pool.pool as never)
    const { getAllLlmBatchCapabilities, recordLlmBatchCapability } = await import('./llm-batch-jobs')

    await recordLlmBatchCapability('gemini-native', { ok: false, message: 'broken', source: 'enrich' })
    await recordLlmBatchCapability('openai-compatible', { ok: true, message: null, source: 'reprocess' })

    await expect(getAllLlmBatchCapabilities()).resolves.toEqual({
      'gemini-native': expect.objectContaining({ ok: false, message: 'broken' }),
      'openai-compatible': expect.objectContaining({ ok: true, message: null }),
    })
  })

  it('never throws when a query fails', async () => {
    const { getDb } = await import('./db')
    vi.mocked(getDb).mockReturnValue(drizzle({ query: vi.fn().mockRejectedValue(new Error('connection reset')) } as never) as never)
    const { insertLlmBatchJob, listPendingLlmBatchJobs, deleteLlmBatchJob } = await import('./llm-batch-jobs')

    await expect(insertLlmBatchJob({ jobName: 'x', source: 'enrich', itemCount: 1 })).resolves.toBe(false)
    await expect(listPendingLlmBatchJobs()).resolves.toEqual([])
    await expect(deleteLlmBatchJob('x')).resolves.toBeUndefined()
  })
})
