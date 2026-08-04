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
// drizzle(client) just needs to return something identifiable; the actual
// migration work happens in the mocked migrate() below.
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: (client: unknown) => ({ __client: client }) }))
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

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
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
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
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
    expect(client.query).toHaveBeenLastCalledWith(
      `SELECT pg_advisory_unlock(hashtext('zvg-immo:schema-migrations'))`,
    )
    expect(client.release).toHaveBeenCalledOnce()
  })
})
