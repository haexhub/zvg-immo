import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction, LocationEnrichment } from '~/types/auction'

vi.mock('../../../utils/auction-snapshot', () => ({ readAuctionSnapshot: vi.fn() }))
vi.mock('../../../utils/geocode', () => ({ geocodeAddress: vi.fn() }))
vi.mock('../../../utils/external-data/location-enrichment', () => ({ readLocationEnrichment: vi.fn() }))

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'zvg-portal',
    country: 'de',
    region: 'Bayern',
    externalId: '7265',
    caseNumber: '12 K 34/26',
    authority: 'AG Muenchen',
    title: 'Einfamilienhaus',
    address: 'Musterstrasse 1, Muenchen',
    marketValueEur: 450_000,
    marketValueText: '450.000 EUR',
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
    ...overrides,
  }
}

const enrichment: LocationEnrichment = {
  platform: 'zvg-portal',
  externalId: '7265',
  lat: 48.137,
  lng: 11.575,
  checkedAt: '2026-07-26T10:00:00.000Z',
  sourceVersion: 'test',
  hazards: [],
  marketComparison: null,
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/auction/:platform/:id location enrichment overlay', () => {
  it('returns cached locationEnrichment without live external fetches', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const { readAuctionSnapshot } = await import('../../../utils/auction-snapshot')
    const { geocodeAddress } = await import('../../../utils/geocode')
    const { readLocationEnrichment } = await import('../../../utils/external-data/location-enrichment')
    vi.mocked(readAuctionSnapshot).mockResolvedValue({
      'zvg-portal:7265': auction({ lat: 48.1, lng: 11.5 }),
    })
    vi.mocked(geocodeAddress).mockResolvedValue({ lat: 1, lng: 2, displayName: 'Ignored' } as never)
    vi.mocked(readLocationEnrichment).mockResolvedValue(enrichment)

    const handler = (await import('./[id].get')).default as unknown as (event: {
      context: { params: { platform: string; id: string } }
    }) => Promise<unknown>

    await expect(handler({ context: { params: { platform: 'zvg-portal', id: '7265' } } })).resolves.toMatchObject({
      platform: 'zvg-portal',
      externalId: '7265',
      lat: 48.1,
      lng: 11.5,
      locationEnrichment: enrichment,
    })
    expect(readLocationEnrichment).toHaveBeenCalledWith('zvg-portal', '7265')
  })
})
