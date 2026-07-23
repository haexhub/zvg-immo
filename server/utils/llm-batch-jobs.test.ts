import { describe, expect, it, vi } from 'vitest'

vi.mock('./db', () => ({ getPool: vi.fn() }))

function makeFakePool() {
  const rows: Array<{ job_name: string; source: string; status: string; item_count: number }> = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('INSERT INTO llm_batch_jobs')) {
      rows.push({
        job_name: params[0] as string,
        source: params[1] as string,
        status: 'pending',
        item_count: params[2] as number,
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes("SELECT job_name, source, status, item_count FROM llm_batch_jobs WHERE status = 'pending'")) {
      return { rows: rows.filter((r) => r.status === 'pending'), rowCount: rows.length }
    }
    if (sql.startsWith('DELETE FROM llm_batch_jobs')) {
      const idx = rows.findIndex((r) => r.job_name === params[0])
      if (idx >= 0) rows.splice(idx, 1)
      return { rows: [], rowCount: idx >= 0 ? 1 : 0 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query, rows }
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

    expect(pending).toEqual([{ jobName: 'batches/abc', source: 'reprocess', status: 'pending', itemCount: 3 }])
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

  it('never throws when a query fails', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('connection reset')) } as never)
    const { insertLlmBatchJob, listPendingLlmBatchJobs, deleteLlmBatchJob } = await import('./llm-batch-jobs')

    await expect(insertLlmBatchJob({ jobName: 'x', source: 'enrich', itemCount: 1 })).resolves.toBe(false)
    await expect(listPendingLlmBatchJobs()).resolves.toEqual([])
    await expect(deleteLlmBatchJob('x')).resolves.toBeUndefined()
  })
})
