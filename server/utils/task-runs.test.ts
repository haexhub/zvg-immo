import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  lastWarning: null,
  lastLlmError: null,
  progress: null,
  progressByCountry: null,
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
  beforeEach(() => {
    vi.resetModules()
  })

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
    expect(running.progress).toBeNull()

    await recordTaskRunEnd('enrich', { result: SUMMARY })
    const finished = await getTaskRunStatus('enrich')
    expect(finished.status).toBe('idle')
    expect(typeof finished.finishedAt).toBe('string')
    expect(finished.startedAt).toBe(running.startedAt)
    expect(finished.lastResult).toEqual(SUMMARY)
    expect(finished.lastError).toBeNull()
    expect(finished.lastWarning).toBeNull()
    expect(finished.progress).toBeNull()
  })

  it('reports throttled progress while a run is in flight, then clears it on finish', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { getTaskRunStatus, recordTaskRunStart, recordTaskRunEnd, recordTaskRunProgress } = await import('./task-runs')
    const nowSpy = vi.spyOn(Date, 'now')

    const T0 = 10_000_000
    nowSpy.mockReturnValue(T0)
    await recordTaskRunStart('reprocess')

    nowSpy.mockReturnValue(T0 + 2000)
    await recordTaskRunProgress('reprocess', { candidatesTotal: 10, processed: 1 })
    expect((await getTaskRunStatus('reprocess')).progress).toEqual({ candidatesTotal: 10, processed: 1 })

    // Within the throttle window — dropped, last write wins.
    nowSpy.mockReturnValue(T0 + 2100)
    await recordTaskRunProgress('reprocess', { candidatesTotal: 10, processed: 2 })
    expect((await getTaskRunStatus('reprocess')).progress).toEqual({ candidatesTotal: 10, processed: 1 })

    // Past the throttle window — applied.
    nowSpy.mockReturnValue(T0 + 3700)
    await recordTaskRunProgress('reprocess', { candidatesTotal: 10, processed: 3 })
    expect((await getTaskRunStatus('reprocess')).progress).toEqual({ candidatesTotal: 10, processed: 3 })

    await recordTaskRunEnd('reprocess', { result: { processed: 3 } })
    expect((await getTaskRunStatus('reprocess')).progress).toBeNull()

    nowSpy.mockRestore()
  })

  it('never lets an in-flight progress write land after — and clobber — an end write (interleaving regression)', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    // Holds recordTaskRunProgress's own write (identified by its `progress`
    // payload — recordTaskRunStart/End always write `progress: null`) so it
    // can be released after recordTaskRunEnd has already completed, exactly
    // the interleaving that used to restore a stale 'running' status once
    // the delayed progress write finally landed.
    let releaseProgressWrite: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseProgressWrite = resolve
    })
    const originalQuery = pool.query
    pool.query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('INSERT INTO app_settings') && sql.includes('value || jsonb_build_object')) {
        const value = typeof params[2] === 'string' ? JSON.parse(params[2] as string) : params[2]
        if ((value as { progress?: unknown }).progress) await gate
      }
      return originalQuery(sql, params)
    })
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { getTaskRunStatus, recordTaskRunStart, recordTaskRunEnd, recordTaskRunProgress } = await import('./task-runs')

    await recordTaskRunStart('enrich')
    const progressPromise = recordTaskRunProgress('enrich', { archivedDone: 1, archivedTotal: 10 })
    const endPromise = recordTaskRunEnd('enrich', { result: { archived: 10 } })
    releaseProgressWrite!()
    await Promise.all([progressPromise, endPromise])

    const status = await getTaskRunStatus('enrich')
    expect(status.status).toBe('idle')
    expect(status.lastResult).toEqual({ archived: 10 })
    expect(status.progress).toBeNull()
  })

  it('records a successful run warning for admin visibility', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { getTaskRunStatus, recordTaskRunStart, recordTaskRunEnd } = await import('./task-runs')

    await recordTaskRunStart('reprocess')
    await recordTaskRunEnd('reprocess', { result: { processed: 0, skipped: 1, llmCalls: 1 }, warning: 'LLM-Rate-Limit: gemini-native/gemini-3.6-flash.' })

    const status = await getTaskRunStatus('reprocess')
    expect(status.status).toBe('idle')
    expect(status.lastWarning).toBe('LLM-Rate-Limit: gemini-native/gemini-3.6-flash.')
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
    expect(status.lastWarning).toBeNull()
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
