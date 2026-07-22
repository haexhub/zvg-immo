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
})
