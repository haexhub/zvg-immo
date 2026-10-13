import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./db', () => ({ getPool: vi.fn() }))
vi.mock('~/server/crawlers/registry', () => ({
  ensureEnabledCountriesLoaded: vi.fn(async () => {}),
  getEnabledCountryCodes: vi.fn(() => ['de', 'at']),
}))

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

    const selectCall = query.mock.calls.find(([statement]) => (statement as string).includes('OFFSET'))!
    // Current-only collection: not expired, not dropped by the last completed
    // crawl of its scope, not withdrawn — and a stable order for LIMIT/OFFSET.
    expect(selectCall[0]).toContain('(a.auction_date_iso IS NULL OR a.auction_date_iso >= now())')
    expect(selectCall[0]).toContain('a.last_seen_at < cs.last_success_at')
    expect(selectCall[0]).toContain('a.cancelled = false')
    expect(selectCall[0]).toContain('ORDER BY a.platform, a.external_id')
    expect(selectCall[0]).toContain('LIMIT $5 OFFSET $6')
    expect(selectCall[0]).not.toContain('payload')
    expect(selectCall[0]).toContain('a.country = ANY($1::text[])')
    expect(selectCall[1]).toEqual([['de'], 'Bayern', 'zvg-portal', 'einfamilienhaus', 25, 25])
    const countCall = query.mock.calls.find(([statement]) => (statement as string).includes('COUNT(*)'))!
    expect(countCall[1]).toEqual([['de'], 'Bayern', 'zvg-portal', 'einfamilienhaus'])
    expect(countCall[0]).toContain('a.last_seen_at < cs.last_success_at')
  })

  it('scopes the collection to enabled countries, so a paused country returns nothing', async () => {
    const { getPool } = await import('./db')
    const query = vi.fn(async (statement: string) => ({ rows: statement.includes('COUNT(*)') ? [{ total: '0' }] : [] }))
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const { readPublicAuctions } = await import('./data-api-auction')
    const base = { includeWithdrawn: false, page: 1, pageSize: 25 }

    await readPublicAuctions(base)
    expect(query.mock.calls[0]?.[1]).toEqual([['de', 'at']])

    query.mockClear()
    await readPublicAuctions({ ...base, country: 'fr' })
    expect(query.mock.calls[0]?.[1]).toEqual([[]])
  })

  it('keeps withdrawn auctions when includeWithdrawn is set', async () => {
    const { getPool } = await import('./db')
    const query = vi.fn(async (statement: string) => ({ rows: statement.includes('COUNT(*)') ? [{ total: '0' }] : [] }))
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const { readPublicAuctions } = await import('./data-api-auction')

    await readPublicAuctions({ includeWithdrawn: true, page: 1, pageSize: 25 })

    for (const [statement] of query.mock.calls) expect(statement).not.toContain('a.cancelled = false')
  })
})

describe('readPublicAuctionLinks', () => {
  it('reads the current collection in one bounded, stably ordered query without COUNT or OFFSET', async () => {
    const { getPool } = await import('./db')
    const query = vi.fn(async () => ({
      rows: [{ platform: 'zvg-portal', external_id: '7265', source_updated_iso: new Date('2026-08-01T10:00:00.000Z') }],
    }))
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const { readPublicAuctionLinks } = await import('./data-api-auction')

    await expect(readPublicAuctionLinks(100)).resolves.toEqual([
      { appUrl: '/objekt/zvg-portal/7265', lastUpdated: '2026-08-01T10:00:00.000Z' },
    ])
    expect(query).toHaveBeenCalledOnce()
    const [statement, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(statement).toContain('(a.auction_date_iso IS NULL OR a.auction_date_iso >= now())')
    expect(statement).toContain('a.last_seen_at < cs.last_success_at')
    expect(statement).toContain('a.cancelled = false')
    expect(statement).toContain('ORDER BY a.platform, a.external_id')
    expect(statement).toContain('a.country = ANY($1::text[])')
    expect(statement).toContain('LIMIT $2')
    expect(statement).not.toContain('COUNT(*)')
    expect(statement).not.toContain('OFFSET')
    expect(params).toEqual([['de', 'at'], 100])
  })
})
