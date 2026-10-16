import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/data-api-auction', () => ({ readPublicAuctions: vi.fn() }))

const auction = {
  platform: 'zvg-portal', country: 'de', region: 'Bayern', id: '7265', court: 'AG München',
  caseNumber: '1 K 1/26', title: 'Haus', address: 'Musterstraße 1', marketValueEur: 450000,
  marketValue: 450000, currency: 'EUR', auctionDate: '2026-10-15T10:00:00.000Z', withdrawn: false,
  propertyType: 'einfamilienhaus', landAreaSqm: 500, livingAreaSqm: 120, rooms: 4, units: 1,
  photoCount: 2, lastUpdated: '2026-08-01T10:00:00.000Z', appUrl: '/objekt/zvg-portal/7265',
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/data/v1/auctions', () => {
  it('preserves the paginated v1 contract while delegating all filters to the bounded repository', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({
      country: 'DE', region: 'Bayern', platform: 'zvg-portal', propertyType: 'einfamilienhaus',
      includeWithdrawn: '1', page: '2', pageSize: '25',
    }))
    const { readPublicAuctions } = await import('../../../utils/data-api-auction')
    vi.mocked(readPublicAuctions).mockResolvedValue({ data: [auction], total: 26 })
    const handler = (await import('./auctions.get')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({
      data: [auction], page: 2, pageSize: 25, total: 26, totalPages: 2,
    })
    expect(readPublicAuctions).toHaveBeenCalledWith({
      country: 'de', region: 'Bayern', platform: 'zvg-portal', propertyType: 'einfamilienhaus',
      includeWithdrawn: true, page: 2, pageSize: 25,
    })
  })
})
