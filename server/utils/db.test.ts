import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  poolQuery: vi.fn(),
  connect: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }))
vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { query: mocks.poolQuery, connect: mocks.connect }
  }),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('runMigrations', () => {
  it('serializes schema application with a session advisory lock', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: 'postgres://test' }))
    mocks.readFile.mockResolvedValue('SELECT 1;')
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ locked: true }] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)
    const { runMigrations } = await import('./db')

    await runMigrations()

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      `SELECT pg_try_advisory_lock(hashtext('zvg-immo:schema-migrations')) AS locked`,
      'SELECT 1;',
      `SELECT pg_advisory_unlock(hashtext('zvg-immo:schema-migrations'))`,
    ])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('retries the lock instead of applying the schema while another instance holds it', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: 'postgres://test' }))
    mocks.readFile.mockResolvedValue('SELECT 1;')
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ locked: false }] })
        .mockResolvedValueOnce({ rows: [{ locked: true }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)
    const { runMigrations } = await import('./db')

    await runMigrations()

    const tryLock = `SELECT pg_try_advisory_lock(hashtext('zvg-immo:schema-migrations')) AS locked`
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      tryLock,
      tryLock,
      'SELECT 1;',
      `SELECT pg_advisory_unlock(hashtext('zvg-immo:schema-migrations'))`,
    ])
  })

  it('releases the migration lock and client after a schema error', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: 'postgres://test' }))
    mocks.readFile.mockResolvedValue('BROKEN SQL')
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ locked: true }] })
        .mockRejectedValueOnce(new Error('migration failed'))
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)
    const { runMigrations } = await import('./db')

    await expect(runMigrations()).rejects.toThrow('migration failed')
    expect(client.query).toHaveBeenLastCalledWith(
      `SELECT pg_advisory_unlock(hashtext('zvg-immo:schema-migrations'))`,
    )
    expect(client.release).toHaveBeenCalledOnce()
  })
})

describe('isStatementTimeoutError', () => {
  it('recognizes the pg SQLSTATE for a statement_timeout cancellation', async () => {
    const { isStatementTimeoutError } = await import('./db')
    expect(isStatementTimeoutError({ code: '57014' })).toBe(true)
  })

  it('rejects unrelated errors, including ones with an unrelated code', async () => {
    const { isStatementTimeoutError } = await import('./db')
    expect(isStatementTimeoutError(new Error('boom'))).toBe(false)
    expect(isStatementTimeoutError({ code: '23505' })).toBe(false)
    expect(isStatementTimeoutError(null)).toBe(false)
    expect(isStatementTimeoutError('57014')).toBe(false)
  })
})

describe('withStatementTimeout', () => {
  it('scopes statement_timeout to the transaction with SET LOCAL, not SET', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }
    const db = { connect: vi.fn().mockResolvedValue(client) }
    const { withStatementTimeout } = await import('./db')

    const result = await withStatementTimeout(db as never, 10_000, async (c) => {
      await c.query('SELECT 1')
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 10000',
      'SELECT 1',
      'COMMIT',
    ])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('rolls back and releases the client, but still rethrows, when fn fails', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    const db = { connect: vi.fn().mockResolvedValue(client) }
    const { withStatementTimeout } = await import('./db')
    const timeoutError = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })

    await expect(
      withStatementTimeout(db as never, 10_000, async () => {
        throw timeoutError
      }),
    ).rejects.toBe(timeoutError)

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 10000',
      'ROLLBACK',
    ])
    expect(client.release).toHaveBeenCalledOnce()
  })
})
