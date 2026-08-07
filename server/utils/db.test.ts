import { afterEach, describe, expect, it, vi } from 'vitest'
import { callQueryText as queryText } from '~/test-support/drizzle-query'

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

// Drizzle wraps every driver rejection in a DrizzleQueryError whose own message
// is `Failed query: <sql>` and whose `cause` holds the pg error — so anything
// reading `err.code` off a Drizzle-issued query sees nothing without this.
describe('pgErrorCode / pgErrorMessage', () => {
  const wrapped = (cause: unknown) =>
    Object.assign(new Error('Failed query: insert into "x"\nparams: 1'), { cause })

  it('reads the SQLSTATE out of a Drizzle-wrapped pg error', async () => {
    const { pgErrorCode } = await import('./db')
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })
    expect(pgErrorCode(wrapped(pgError))).toBe('23505')
    expect(pgErrorCode(wrapped(wrapped(pgError)))).toBe('23505')
    expect(pgErrorCode(pgError)).toBe('23505')
  })

  it('returns undefined when no SQLSTATE is present anywhere in the chain', async () => {
    const { pgErrorCode } = await import('./db')
    expect(pgErrorCode(wrapped(new Error('socket hang up')))).toBeUndefined()
    expect(pgErrorCode(new Error('boom'))).toBeUndefined()
    expect(pgErrorCode(null)).toBeUndefined()
    expect(pgErrorCode('23505')).toBeUndefined()
  })

  it('prefers the pg message over Drizzle\'s "Failed query" wrapper', async () => {
    const { pgErrorMessage } = await import('./db')
    const pgError = Object.assign(new Error('Geometry contains an interior ring outside'), { code: 'XX000' })
    expect(pgErrorMessage(wrapped(pgError))).toBe('Geometry contains an interior ring outside')
    expect(pgErrorMessage(new Error('boom'))).toBe('boom')
    expect(pgErrorMessage('plain string')).toBe('plain string')
  })

  it('recognizes a statement_timeout that arrives wrapped', async () => {
    const { isStatementTimeoutError } = await import('./db')
    const pgError = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    expect(isStatementTimeoutError(wrapped(pgError))).toBe(true)
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
