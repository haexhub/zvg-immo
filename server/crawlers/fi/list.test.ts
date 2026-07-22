import { describe, expect, it } from 'vitest'
import { mapDetail, type ApiEntry, type ApiResponse } from './list'

function makeResponse(overrides: Partial<ApiEntry> = {}): ApiResponse {
  return {
    entry: {
      id: 123456,
      slug: 'kerrostaloasunto-helsinki',
      title: 'Kerrostaloasunto',
      categoryName: 'Kerrostaloasunto',
      description: null,
      location: 'Helsinki',
      auctionStart: '2026-08-01T08:00:00Z',
      auctionEnd: '2026-08-15T15:00:00Z',
      startPrice: 50000,
      highestBid: 62000,
      bidCount: 4,
      isCancelled: false,
      fundsAreCanceled: false,
      exhibit: null,
      geocode: null,
      metadata: { category: 'RealEstate' },
      medias: null,
      attachments: null,
      ...overrides,
    },
    seller: { displayName: 'Ulosottolaitos' },
  }
}

describe('mapDetail', () => {
  it('sets startingBid from startPrice and currentBid from highestBid when bids exist', () => {
    const a = mapDetail('123456', makeResponse(), 'fi-huutokaupat')
    expect(a.startingBid).toBe(50000)
    expect(a.currentBid).toBe(62000)
  })

  it('sets currentBid to null when highestBid is 0', () => {
    const a = mapDetail('123456', makeResponse({ highestBid: 0 }), 'fi-huutokaupat')
    expect(a.startingBid).toBe(50000)
    expect(a.currentBid).toBeNull()
  })

  it('sets currentBid to null when highestBid is absent', () => {
    const a = mapDetail('123456', makeResponse({ highestBid: null }), 'fi-huutokaupat')
    expect(a.currentBid).toBeNull()
  })

  it('sets startingBid to null when startPrice is absent', () => {
    const a = mapDetail('123456', makeResponse({ startPrice: null }), 'fi-huutokaupat')
    expect(a.startingBid).toBeNull()
  })
})
