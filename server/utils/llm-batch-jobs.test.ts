import { describe, expect, it, vi } from 'vitest'

vi.mock('./db', () => ({ getPool: vi.fn() }))

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
  }> = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('INSERT INTO llm_batch_jobs')) {
      rows.push({
        job_name: params[0] as string,
        source: params[1] as string,
        status: 'pending',
        item_count: params[2] as number,
        custom_id_map: params[3] ? JSON.parse(params[3] as string) : {},
        submitted_at: '2026-07-26T18:00:00.000Z',
        checked_at: null,
        updated_at: '2026-07-26T18:00:00.000Z',
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT job_name, source, status, item_count, custom_id_map, submitted_at, checked_at, updated_at')) {
      return { rows: rows.filter((r) => r.status === 'pending'), rowCount: rows.length }
    }
    if (sql.startsWith('DELETE FROM llm_batch_jobs')) {
      const idx = rows.findIndex((r) => r.job_name === params[0])
      if (idx >= 0) rows.splice(idx, 1)
      return { rows: [], rowCount: idx >= 0 ? 1 : 0 }
    }
    if (sql.startsWith('UPDATE llm_batch_jobs SET checked_at')) {
      const row = rows.find((r) => r.job_name === params[0])
      if (row) {
        row.checked_at = params[1] as string
        row.updated_at = params[1] as string
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }
    if (sql.startsWith('SELECT value FROM app_settings')) {
      const value = settings.get(params[0] as string)
      return { rows: value === undefined ? [] : [{ value }], rowCount: value === undefined ? 0 : 1 }
    }
    if (sql.startsWith('INSERT INTO app_settings')) {
      settings.set(params[0] as string, JSON.parse(params[1] as string))
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query, rows, settings }
}

describe('llm-batch-jobs', () => {
  it('is a no-op everywhere without a configured pool', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(null)
    const { insertLlmBatchJob, listPendingLlmBatchJobs, deleteLlmBatchJob } = await import('./llm-batch-jobs')

    await insertLlmBatchJob({ jobName: 'batches/1', source: 'enrich', itemCount: 5 })
    await expect(listPendingLlmBatchJobs()).resolves.toEqual([])
    await expect(deleteLlmBatchJob('batches/1')).resolves.toBeUndefined()
  })

  it('inserts a job and lists it as pending', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
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
      },
    ])
  })

  it('persists and returns an Anthropic custom_id map', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
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
      },
    ])
  })

  it('deletes a job, removing it from the pending list', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { insertLlmBatchJob, listPendingLlmBatchJobs, deleteLlmBatchJob } = await import('./llm-batch-jobs')

    await insertLlmBatchJob({ jobName: 'batches/abc', source: 'enrich', itemCount: 3 })
    await deleteLlmBatchJob('batches/abc')

    await expect(listPendingLlmBatchJobs()).resolves.toEqual([])
  })

  it('updates checked_at for a pending job', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
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
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
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

  it('never throws when a query fails', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('connection reset')) } as never)
    const { insertLlmBatchJob, listPendingLlmBatchJobs, deleteLlmBatchJob } = await import('./llm-batch-jobs')

    await expect(insertLlmBatchJob({ jobName: 'x', source: 'enrich', itemCount: 1 })).resolves.toBe(false)
    await expect(listPendingLlmBatchJobs()).resolves.toEqual([])
    await expect(deleteLlmBatchJob('x')).resolves.toBeUndefined()
  })
})
