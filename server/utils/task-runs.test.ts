import { describe, expect, it, vi } from 'vitest'

vi.mock('./db', () => ({ getPool: vi.fn() }))

function makeFakePool() {
  const settings = new Map<string, unknown>()
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT value FROM app_settings')) {
      const value = settings.get(params[0] as string)
      return { rows: value === undefined ? [] : [{ value }], rowCount: value === undefined ? 0 : 1 }
    }
    if (sql.startsWith('INSERT INTO app_settings') && sql.includes('value || jsonb_build_object')) {
      // Atomic per-task merge (writeTaskRunStatus): params = [key, task, jsonValue].
      const key = params[0] as string
      const task = params[1] as string
      const value = typeof params[2] === 'string' ? JSON.parse(params[2] as string) : params[2]
      const current = (settings.get(key) as Record<string, unknown> | undefined) ?? {}
      settings.set(key, { ...current, [task]: value })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query, settings }
}

const IDLE_STATUS = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  lastError: null,
}

const SUMMARY = {
  crawled: 10,
  new: 3,
  cached: 7,
  enriched: 3,
  llmCalls: 2,
  photoExtractions: 1,
  photosTotal: 5,
  confident: 2,
  durationMs: 4500,
}

describe('task-runs', () => {
  it('defaults to idle without a configured pool', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(null)
    const { getTaskRunStatus } = await import('./task-runs')

    await expect(getTaskRunStatus('enrich')).resolves.toEqual(IDLE_STATUS)
  })

  it('tracks a run from start through a successful finish', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { getTaskRunStatus, recordTaskRunStart, recordTaskRunEnd } = await import('./task-runs')

    await recordTaskRunStart('enrich')
    const running = await getTaskRunStatus('enrich')
    expect(running.status).toBe('running')
    expect(typeof running.startedAt).toBe('string')
    expect(running.lastResult).toBeNull()

    await recordTaskRunEnd('enrich', { result: SUMMARY })
    const finished = await getTaskRunStatus('enrich')
    expect(finished.status).toBe('idle')
    expect(typeof finished.finishedAt).toBe('string')
    expect(finished.startedAt).toBe(running.startedAt)
    expect(finished.lastResult).toEqual(SUMMARY)
    expect(finished.lastError).toBeNull()
  })

  it('records a failed run without discarding the previous successful result', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { getTaskRunStatus, recordTaskRunStart, recordTaskRunEnd } = await import('./task-runs')

    await recordTaskRunStart('enrich')
    await recordTaskRunEnd('enrich', { result: SUMMARY })

    await recordTaskRunStart('enrich')
    await recordTaskRunEnd('enrich', { error: 'crawl failed: timeout' })

    const status = await getTaskRunStatus('enrich')
    expect(status.status).toBe('idle')
    expect(status.lastError).toBe('crawl failed: timeout')
    // A failed run keeps the last known-good result visible instead of
    // wiping it, so /settings still shows what the pipeline last produced.
    expect(status.lastResult).toEqual(SUMMARY)
  })

  it('never throws when a query fails', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('connection reset')) } as never)
    const { getTaskRunStatus, recordTaskRunStart, recordTaskRunEnd } = await import('./task-runs')

    await expect(getTaskRunStatus('enrich')).resolves.toEqual(IDLE_STATUS)
    await expect(recordTaskRunStart('enrich')).resolves.toBeUndefined()
    await expect(recordTaskRunEnd('enrich', { result: SUMMARY })).resolves.toBeUndefined()
  })
})
