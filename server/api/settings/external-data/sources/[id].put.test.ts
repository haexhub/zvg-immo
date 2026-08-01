import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn(() => null) }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

function fakePool() {
  const rows = new Map<string, unknown>()
  return {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT value FROM app_settings WHERE key =')) {
        const [key] = params as [string]
        return rows.has(key) ? { rows: [{ value: rows.get(key) }] } : { rows: [] }
      }
      if (sql.includes('INSERT INTO app_settings')) {
        const [key, value] = params as [string, string]
        rows.set(key, JSON.parse(value))
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
}

describe('PUT /api/settings/external-data/sources/:id', () => {
  it('404s for an unknown/unconfigurable source id', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./[id].put')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({ context: { params: { id: 'eurostat-house-price-index' } } })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('503s when Postgres is not configured', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./[id].put')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({ context: { params: { id: 'eea-environmental-noise-directive' } } })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('saves a valid override and echoes back the coerced values', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('readBody', vi.fn(async () => ({ serviceBaseUrl: 'https://mirror.example/services/noiseStoryMap', timeoutMs: '5000' })))

    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue(fakePool() as never)

    const handler = (await import('./[id].put')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({ context: { params: { id: 'eea-environmental-noise-directive' } } })).resolves.toEqual({
      id: 'eea-environmental-noise-directive',
      values: { serviceBaseUrl: 'https://mirror.example/services/noiseStoryMap', timeoutMs: 5000 },
    })
  })
})
