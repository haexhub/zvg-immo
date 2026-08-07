import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  connect: vi.fn(),
  migrate: vi.fn(),
}))

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return { query: mocks.poolQuery, connect: mocks.connect }
  }),
}))
vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate: mocks.migrate }))

// db.ts issues its BEGIN/COMMIT/ROLLBACK/advisory-lock statements through a
// real Drizzle session now, which calls client.query() with a {text, ...}
// config object instead of a plain string — pull just the text back out.
const queryText = (call: unknown[]): unknown => {
  const arg = call[0]
  return typeof arg === 'string' ? arg : (arg as { text: string }).text
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('runMigrations', () => {
  it('serializes migration application with a session advisory lock', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: 'postgres://test' }))
    mocks.migrate.mockResolvedValue(undefined)
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ locked: true }] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)
    const { runMigrations } = await import('./db')

    await runMigrations()

    expect(client.query.mock.calls.map(queryText)).toEqual([
      `SELECT pg_try_advisory_lock(hashtext('zvg-immo:schema-migrations')) AS locked`,
      `SELECT pg_advisory_unlock(hashtext('zvg-immo:schema-migrations'))`,
    ])
    expect(mocks.migrate).toHaveBeenCalledOnce()
    expect(mocks.migrate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ migrationsFolder: expect.stringContaining('server/db/migrations') }),
    )
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('retries the lock instead of migrating while another instance holds it', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: 'postgres://test' }))
    mocks.migrate.mockResolvedValue(undefined)
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
    expect(client.query.mock.calls.map(queryText)).toEqual([
      tryLock,
      tryLock,
      `SELECT pg_advisory_unlock(hashtext('zvg-immo:schema-migrations'))`,
    ])
    expect(mocks.migrate).toHaveBeenCalledOnce()
  })

  it('releases the migration lock and client after a migration error', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: 'postgres://test' }))
    mocks.migrate.mockRejectedValue(new Error('migration failed'))
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ locked: true }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)
    const { runMigrations } = await import('./db')

    await expect(runMigrations()).rejects.toThrow('migration failed')
    expect(queryText(client.query.mock.calls.at(-1)!)).toBe(
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
    expect(client.query.mock.calls.map(queryText)).toEqual([
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

    expect(client.query.mock.calls.map(queryText)).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 10000',
      'ROLLBACK',
    ])
    expect(client.release).toHaveBeenCalledOnce()
  })
})
