import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./db', () => ({ getPool: vi.fn() }))

interface FakeRow {
  id: number
  task: string
  platform: string | null
  external_id: string | null
  category: string
  message: string
  created_at: string
}

function makeFakePool() {
  const rows: FakeRow[] = []
  let nextId = 1
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('INSERT INTO task_run_errors')) {
      const [task, platform, externalId, category, message] = params as [string, string | null, string | null, string, string]
      rows.push({ id: nextId++, task, platform, external_id: externalId, category, message, created_at: new Date(rows.length).toISOString() })
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('DELETE FROM task_run_errors')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.startsWith('SELECT id, task, platform, external_id, category, message, created_at')) {
      const [task, limit] = params as [string, number]
      const matching = rows.filter((row) => row.task === task).slice().reverse().slice(0, limit)
      return { rows: matching, rowCount: matching.length }
    }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query, rows }
}

describe('task-run-errors', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('is a no-op without a configured pool', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(null)
    const { recordTaskRunError, listRecentTaskRunErrors } = await import('./task-run-errors')

    await expect(recordTaskRunError('enrich', { category: 'document_archive_incomplete', message: 'x' })).resolves.toBeUndefined()
    await expect(listRecentTaskRunErrors('enrich')).resolves.toEqual([])
  })

  it('records an error and reads it back', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { recordTaskRunError, listRecentTaskRunErrors } = await import('./task-run-errors')

    await recordTaskRunError('enrich', {
      category: 'document_archive_incomplete',
      message: 'Dokumentarchiv se-kronofogden:101746 ist unvollständig: F-2209-25.pdf: HTTP 403',
      platform: 'se-kronofogden',
      externalId: '101746',
    })

    const errors = await listRecentTaskRunErrors('enrich')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      task: 'enrich',
      platform: 'se-kronofogden',
      externalId: '101746',
      category: 'document_archive_incomplete',
      message: 'Dokumentarchiv se-kronofogden:101746 ist unvollständig: F-2209-25.pdf: HTTP 403',
    })
  })

  it('defaults platform/externalId to null when omitted', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { recordTaskRunError, listRecentTaskRunErrors } = await import('./task-run-errors')

    await recordTaskRunError('enrich', { category: 'crawl', message: 'se/Schweden: kronofogden.se search failed' })

    const [error] = await listRecentTaskRunErrors('enrich')
    expect(error?.platform).toBeNull()
    expect(error?.externalId).toBeNull()
  })

  it('only returns errors for the requested task', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { recordTaskRunError, listRecentTaskRunErrors } = await import('./task-run-errors')

    await recordTaskRunError('enrich', { category: 'crawl', message: 'enrich failure' })
    await recordTaskRunError('reprocess', { category: 'llm', message: 'reprocess failure' })

    expect(await listRecentTaskRunErrors('enrich')).toHaveLength(1)
    expect(await listRecentTaskRunErrors('reprocess')).toHaveLength(1)
  })

  it('never throws when the query fails', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('connection reset')) } as never)
    const { recordTaskRunError, listRecentTaskRunErrors } = await import('./task-run-errors')

    await expect(recordTaskRunError('enrich', { category: 'crawl', message: 'x' })).resolves.toBeUndefined()
    await expect(listRecentTaskRunErrors('enrich')).resolves.toEqual([])
  })
})
