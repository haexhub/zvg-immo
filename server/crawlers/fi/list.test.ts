import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAllListings, mapDetail, type ApiEntry, type ApiResponse } from './list'

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

describe('fetchAllListings', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function stubHuutokaupat(details: Record<string, Response>): void {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('sivu=1')) return new Response('<a href="/kohde/1/a/"></a><a href="/kohde/2/b/"></a>')
      if (url.includes('sivu=')) return new Response('')
      const id = url.split('/').pop()!
      return details[id] ?? new Response('', { status: 404 })
    }))
  }

  it('reports a complete run when every detail call answered', async () => {
    stubHuutokaupat({
      1: Response.json(makeResponse({ id: 1 })),
      2: Response.json({ ...makeResponse({ id: 2 }), seller: undefined }),
    })
    const result = await fetchAllListings('fi-huutokaupat')
    expect(result.auctions.map((a) => [a.externalId, a.authority])).toEqual([['1', 'Ulosottolaitos'], ['2', 'Ulosottolaitos']])
    expect(result.complete).toBe(true)
  })

  it('reports an incomplete run when a detail call fails or returns no entry', async () => {
    stubHuutokaupat({ 1: new Response('', { status: 502 }), 2: Response.json({ seller: null }) })
    const result = await fetchAllListings('fi-huutokaupat')
    expect(result.auctions).toEqual([])
    expect(result.complete).toBe(false)
  })
})
