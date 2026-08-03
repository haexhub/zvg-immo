import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'

vi.mock('./geocode', () => ({
  geocodeAddress: vi.fn(),
}))

const { fillAuctionGeocodes } = await import('./auction-geocoding')

afterEach(() => {
  vi.clearAllMocks()
})

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'se-kronofogden',
    externalId: '1',
    country: 'se',
    region: 'Schweden',
    authority: 'Kronofogden',
    caseNumber: 'A-1',
    title: 'Villa',
    address: 'Kustvägen 1, Gotland',
    marketValue: null,
    currency: null,
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: '2026-09-01',
    auctionDateText: '2026-09-01',
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: null,
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
    ...overrides,
  } as Auction
}

describe('fillAuctionGeocodes', () => {
  it('fills missing coordinates from the cache without fetching missing entries by default', async () => {
    const { geocodeAddress } = await import('./geocode')
    vi.mocked(geocodeAddress).mockResolvedValue({ lat: 57.64, lng: 18.30, displayName: 'Gotland' })
    const item = auction()

    const result = await fillAuctionGeocodes([item])

    expect(geocodeAddress).toHaveBeenCalledWith('Kustvägen 1, Gotland', 'se', { fetchMissing: false })
    expect(item).toMatchObject({ lat: 57.64, lng: 18.30 })
    expect(result).toEqual({ processed: 1, geocoded: 1, failed: 0 })
  })

  it('does not overwrite crawler-provided coordinates', async () => {
    const { geocodeAddress } = await import('./geocode')
    const item = auction({ lat: 59.33, lng: 18.06 })

    const result = await fillAuctionGeocodes([item], { fetchMissing: true })

    expect(geocodeAddress).not.toHaveBeenCalled()
    expect(item).toMatchObject({ lat: 59.33, lng: 18.06 })
    expect(result).toEqual({ processed: 0, geocoded: 0, failed: 0 })
  })
})
