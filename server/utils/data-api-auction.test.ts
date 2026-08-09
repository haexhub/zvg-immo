import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./db', () => ({ getPool: vi.fn() }))

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('readPublicAuctions', () => {
  it('uses a narrow, current-only SQL projection with bound filters and pagination', async () => {
    const { getPool } = await import('./db')
    const query = vi.fn(async (statement: string, params: unknown[]) => {
      if (statement.includes('COUNT(*)')) return { rows: [{ total: '3' }] }
      return {
        rows: [{
          platform: 'zvg-portal', external_id: '7265', country: 'de', region: 'Bayern',
          authority: 'AG München', case_number: '1 K 1/26', title: 'Haus', address: 'Musterstraße 1',
          market_value_eur: '450000', market_value: '450000', currency: 'EUR',
          auction_date_iso: '2026-10-15T10:00:00.000Z', cancelled: false,
          property_type: 'einfamilienhaus', land_area_sqm: '500', living_area_sqm: '120',
          rooms: '4', units: 1, photo_count: 2, source_updated_iso: '2026-08-01T10:00:00.000Z',
          payload: { mustNotReachMapper: true },
        }],
      }
    })
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const { readPublicAuctions } = await import('./data-api-auction')

    const result = await readPublicAuctions({
      country: 'de', region: 'Bayern', platform: 'zvg-portal', propertyType: 'einfamilienhaus',
      includeWithdrawn: false, page: 2, pageSize: 25,
    })

    expect(result).toEqual({
      data: [{
        platform: 'zvg-portal', id: '7265', country: 'de', region: 'Bayern', court: 'AG München',
        caseNumber: '1 K 1/26', title: 'Haus', address: 'Musterstraße 1', marketValueEur: 450000,
        marketValue: 450000, currency: 'EUR', auctionDate: '2026-10-15T10:00:00.000Z', withdrawn: false,
        propertyType: 'einfamilienhaus', landAreaSqm: 500, livingAreaSqm: 120, rooms: 4, units: 1,
        photoCount: 2, lastUpdated: '2026-08-01T10:00:00.000Z', appUrl: '/objekt/zvg-portal/7265',
      }],
      total: 3,
    })
    expect(result.data).not.toContainEqual(expect.objectContaining({ id: 'expired-but-not-withdrawn' }))

    const selectCall = query.mock.calls.find(([statement]) => (statement as string).includes('OFFSET'))!
    expect(selectCall[0]).toContain('(a.auction_date_iso IS NULL OR a.auction_date_iso >= now())')
    expect(selectCall[0]).toContain('LIMIT $5 OFFSET $6')
    expect(selectCall[0]).not.toContain('payload')
    expect(selectCall[1]).toEqual(['de', 'Bayern', 'zvg-portal', 'einfamilienhaus', 25, 25])
    const countCall = query.mock.calls.find(([statement]) => (statement as string).includes('COUNT(*)'))!
    expect(countCall[1]).toEqual(['de', 'Bayern', 'zvg-portal', 'einfamilienhaus'])
  })
})
