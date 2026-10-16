import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../utils/auction-record', () => ({ readAuctionRecord: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/data/v1/auctions/:platform/:id', () => {
  it('keeps the existing public detail shape', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { readAuctionRecord } = await import('../../../../../utils/auction-record')
    vi.mocked(readAuctionRecord).mockResolvedValue({ auction: {
      platform: 'zvg-portal', externalId: '7265', country: 'de', region: 'Bayern', authority: 'AG München',
      caseNumber: '1 K 1/26', title: 'Haus', address: 'Musterstraße 1', marketValue: 450000,
      marketValueEur: 450000, currency: 'EUR', auctionDateIso: '2026-10-15T10:00:00.000Z', cancelled: false,
      photoCount: 2, sourceUpdatedIso: '2026-08-01T10:00:00.000Z', extraction: { propertyType: 'einfamilienhaus' },
    } } as never)
    const handler = (await import('./[id].get')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({ context: { params: { platform: 'zvg-portal', id: '7265' } } })).resolves.toMatchObject({
      platform: 'zvg-portal', id: '7265', court: 'AG München', propertyType: 'einfamilienhaus',
      appUrl: '/objekt/zvg-portal/7265',
    })
  })

  it('keeps the existing public detail shape and 404 status', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: object) => Object.assign(new Error('api error'), input))
    const { readAuctionRecord } = await import('../../../../../utils/auction-record')
    vi.mocked(readAuctionRecord).mockResolvedValue(null)
    const handler = (await import('./[id].get')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({ context: { params: { platform: 'zvg-portal', id: 'missing' } } }))
      .rejects.toMatchObject({ statusCode: 404, statusMessage: 'Auktion nicht gefunden.' })
  })
})
