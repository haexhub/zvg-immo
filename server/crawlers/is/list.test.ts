import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAllListings } from './list'

function lot(auctionDate: string) {
  return {
    office: 'Sýslumaðurinn á Vesturlandi',
    location: 'Akranes',
    auctionType: 'Byrjun uppboðs',
    lotType: 'Fasteign',
    lotName: 'Kirkjubraut 1',
    lotId: null,
    lotItems: null,
    auctionDate,
    auctionTime: '10:00',
    petitioners: null,
    respondent: null,
    publishText: null,
    auctionTakesPlaceAt: null,
  }
}

function stubFeed(auctionDate: string): void {
  vi.stubGlobal('fetch', vi.fn(async () =>
    Response.json({ data: { getSyslumennAuctions: [lot(auctionDate)] } }),
  ))
}

afterEach(() => vi.unstubAllGlobals())

describe('sýslumenn fetchAllListings', () => {
  it('keeps the fallback externalId stable when a lot without lotId is postponed', async () => {
    stubFeed('1/13/2026, 12:00:00 AM')
    const before = await fetchAllListings('is-syslumenn')
    stubFeed('2/10/2026, 12:00:00 AM')
    const after = await fetchAllListings('is-syslumenn')

    expect(before.auctions[0]?.externalId).toBe('is:Sýslumaðurinn á Vesturlandi:Kirkjubraut 1')
    expect(after.auctions[0]?.externalId).toBe(before.auctions[0]?.externalId)
  })
})
