import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/db', () => ({ getDb: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/data/v1/observations', () => {
  it('keeps the v1 response while selecting only the public scalar observation columns', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({ country: 'DE', from: '2026-08-01', page: '2', pageSize: '25' }))
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: '26' }] })
      .mockResolvedValueOnce({ rows: [{
        platform: 'zvg-portal', country: 'de', region: 'Bayern', external_id: '7265', authority: 'AG München',
        case_number: '1 K 1/26', title: 'Haus', property_type: 'einfamilienhaus', land_area_sqm: '500',
        living_area_sqm: '120', rooms: '4', units: 1, market_value_eur: '450000', market_value: '450000',
        currency: 'EUR', auction_date_iso: '2026-10-15T10:00:00.000Z', cancelled: false,
        captured_at: '2026-08-02T10:00:00.000Z', payload: { mustNotReachMapper: true },
      }] })
    const { getDb } = await import('../../../utils/db')
    vi.mocked(getDb).mockReturnValue({ execute } as never)
    const handler = (await import('./observations.get')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toMatchObject({
      page: 2, pageSize: 25, total: 26, totalPages: 2,
      data: [{ id: '7265', court: 'AG München', capturedAt: '2026-08-02T10:00:00.000Z' }],
    })
    const selectStatement = JSON.stringify(execute.mock.calls[1]![0])
    expect(selectStatement).toContain('external_id')
    expect(selectStatement).not.toContain('SELECT *')
    expect(selectStatement).not.toContain('payload')
  })

  it('keeps existing 503 and invalid-date 400 status codes', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))
    vi.stubGlobal('getQuery', () => ({}))
    const { getDb } = await import('../../../utils/db')
    vi.mocked(getDb).mockReturnValue(null)
    const handler = (await import('./observations.get')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({})).rejects.toMatchObject({ statusCode: 503 })

    vi.mocked(getDb).mockReturnValue({ execute: vi.fn() } as never)
    vi.stubGlobal('getQuery', () => ({ from: 'not-a-date' }))
    await expect(handler({})).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Ungültiges "from"-Datum.' })
  })
})
