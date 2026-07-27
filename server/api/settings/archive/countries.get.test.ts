import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/db', () => ({ getPool: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/archive/countries', () => {
  it('counts auction identities, not every archived artifact', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{ country: 'se', count: '67', last_captured_at: '2026-07-27T07:30:12.000Z' }],
    }))
    const { getPool } = await import('../../../utils/db')
    vi.mocked(getPool).mockReturnValue({ query } as never)

    const handler = (await import('./countries.get')).default as () => Promise<unknown>

    await expect(handler()).resolves.toEqual([
      { code: 'se', label: 'Schweden', count: 67, lastCapturedAt: '2026-07-27T07:30:12.000Z' },
    ])
    expect(query.mock.calls[0]?.[0]).toContain("WHERE kind = 'auction'")
    expect(query.mock.calls[0]?.[0]).toContain('count(DISTINCT (platform, external_id))')
  })
})
