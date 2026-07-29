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
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)
    const { runMigrations } = await import('./db')

    await runMigrations()

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      `SELECT pg_advisory_lock(hashtext('zvg-immo:schema-migrations'))`,
      'SELECT 1;',
      `SELECT pg_advisory_unlock(hashtext('zvg-immo:schema-migrations'))`,
    ])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('releases the migration lock and client after a schema error', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: 'postgres://test' }))
    mocks.readFile.mockResolvedValue('BROKEN SQL')
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
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
