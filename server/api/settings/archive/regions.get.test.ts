import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/db', () => ({ getPool: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/archive/regions', () => {
  it('counts auction identities within the selected country region', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({ country: 'se' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{ region: 'Stockholm', count: '12', last_captured_at: '2026-07-27T07:30:12.000Z' }],
    }))
    const { getPool } = await import('../../../utils/db')
    vi.mocked(getPool).mockReturnValue({ query } as never)

    const handler = (await import('./regions.get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual([
      { region: 'Stockholm', count: 12, lastCapturedAt: '2026-07-27T07:30:12.000Z' },
    ])
    expect(query.mock.calls[0]?.[0]).toContain("WHERE a.country = $1 AND rc.kind = 'auction'")
    expect(query.mock.calls[0]?.[0]).toContain('JOIN auctions a')
    expect(query.mock.calls[0]?.[0]).toContain('count(DISTINCT (rc.platform, rc.external_id))')
  })
})
