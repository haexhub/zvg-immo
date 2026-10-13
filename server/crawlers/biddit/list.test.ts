import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAllPublicSales } from './list'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubSearchPage(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body, status)))
}

/** Shape mirrors the live search-service payload. */
function searchPageFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: [
      {
        content: {
          lotId: 'l_1',
          referenceCode: '297841',
          organisationId: 'org_1',
          organisationReference: 'Notaris Jansens',
          handlingMethod: 'ONLINE_PUBLIC_SALE',
          firstPublicationDateTime: '2026-07-01T08:00:00.000Z',
          biddingStartDateTime: '2026-07-25T12:00:00.000Z',
          biddingEndDateTime: '2026-08-01T12:00:00.000Z',
          startingPrice: 200000.0,
          currentPrice: 215000.0,
          publicSaleStatus: 'CURRENT',
          withdrawn: false,
          properties: [
            {
              propertyType: 'HOUSE',
              title: { nl: 'Woning te Aalst' },
              address: {
                street: { nl: 'Klakbaan' },
                estateNumber: '19',
                postalCode: '9320',
                municipality: { nl: 'Aalst' },
              },
            },
          ],
        },
      },
    ],
    totalElements: 1,
    totalPages: 1,
    numberOfElements: 1,
    first: true,
    last: true,
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchAllPublicSales', () => {
  it('copies startingPrice/currentPrice onto startingBid/currentBid', async () => {
    stubSearchPage(searchPageFixture())
    const { auctions } = await fetchAllPublicSales('biddit')
    expect(auctions).toHaveLength(1)
    expect(auctions[0]?.auction.startingBid).toBe(200000)
    expect(auctions[0]?.auction.currentBid).toBe(215000)
  })

  it('leaves startingBid/currentBid null when the listing has no price yet', async () => {
    const fixture = searchPageFixture()
    const item = (fixture.content as Record<string, unknown>[])[0]!
    const inner = (item as { content: Record<string, unknown> }).content
    inner.startingPrice = null
    inner.currentPrice = null
    stubSearchPage(fixture)
    const { auctions } = await fetchAllPublicSales('biddit')
    expect(auctions[0]?.auction.startingBid).toBeNull()
    expect(auctions[0]?.auction.currentBid).toBeNull()
  })

  it('reports a run with a failed follow-up page as incomplete', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('page=0')
        ? jsonResponse(searchPageFixture({ totalElements: 2, totalPages: 2, last: false }))
        : jsonResponse({}, 503),
    ))
    const result = await fetchAllPublicSales('biddit')
    expect(result.auctions).toHaveLength(1)
    expect(result.totalReported).toBe(2)
    expect(result.complete).toBe(false)
  })

  it('reports a run incomplete when a live re-rank repeats a lot instead of returning a new one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Both pages return 297841: the lot that should have been on page 1 slid
    // past the page boundary and never arrived.
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse(searchPageFixture({ totalElements: 2, totalPages: 2, last: false })),
    ))
    const result = await fetchAllPublicSales('biddit')
    expect(result.auctions).toHaveLength(1)
    expect(result.complete).toBe(false)
  })

  it('reports a run complete when every page loads and all reported lots are distinct', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const fixture = searchPageFixture({ totalElements: 2, totalPages: 2, last: false })
      if (!url.includes('page=0')) {
        const item = (fixture.content as { content: Record<string, unknown> }[])[0]!
        item.content.referenceCode = '297842'
      }
      return jsonResponse(fixture)
    }))
    const result = await fetchAllPublicSales('biddit')
    expect(result.auctions.map((m) => m.auction.externalId).sort()).toEqual(['297841', '297842'])
    expect(result.complete).toBe(true)
  })
})
