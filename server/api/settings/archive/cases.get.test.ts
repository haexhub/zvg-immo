import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/db', () => ({ getPool: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/archive/cases', () => {
  it('lists only auction captures for the selected region', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({ country: 'se', region: 'Stockholm' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{
        platform: 'se-kronofogden',
        external_id: 'abc',
        case_label: 'abc',
        authority: 'Kronofogden',
        count: '1',
        last_captured_at: '2026-07-27T07:30:12.000Z',
      }],
    }))
    const { getPool } = await import('../../../utils/db')
    vi.mocked(getPool).mockReturnValue({ query } as never)

    const handler = (await import('./cases.get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual([
      {
        platform: 'se-kronofogden',
        externalId: 'abc',
        caseLabel: 'abc',
        authority: 'Kronofogden',
        count: 1,
        lastCapturedAt: '2026-07-27T07:30:12.000Z',
      },
    ])
    expect(query.mock.calls[0]?.[0]).toContain("WHERE a.country = $1 AND rc.kind = 'auction'")
    expect(query.mock.calls[0]?.[0]).toContain('JOIN auctions a')
  })
})
