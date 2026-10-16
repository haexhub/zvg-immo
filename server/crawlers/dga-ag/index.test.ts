import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'

const fetchAllListings = vi.fn()
vi.mock('./list', () => ({ fetchAllListings }))
vi.mock('./detail', () => ({ enrichOne: vi.fn() }))

function auction(externalId: string, region: string): Auction {
  return {
    platform: 'dga-ag',
    country: 'de',
    region,
    externalId,
    caseNumber: '',
    authority: 'DGA AG',
    title: null,
    address: null,
    marketValueEur: null,
    marketValueText: null,
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
  }
}

beforeEach(() => {
  fetchAllListings.mockReset()
})

describe('dga-ag crawl', () => {
  it('reports success for a Bundesland run while markers are present', async () => {
    const { dgaAgCrawler } = await import('./index')
    fetchAllListings.mockResolvedValue([auction('S1', 'Sachsen'), auction('B1', 'Bayern'), auction('X1', '')])

    const result = await dgaAgCrawler.crawl({ region: 'sn' })

    expect(result.auctions.map((a) => a.externalId)).toEqual(['S1'])
    expect(result.platformsSucceeded).toEqual(['dga-ag'])
  })

  it('withholds success when no object carries a Bundesland marker (markup change)', async () => {
    const { dgaAgCrawler } = await import('./index')
    fetchAllListings.mockResolvedValue([auction('S1', ''), auction('B1', '')])

    const result = await dgaAgCrawler.crawl({ region: 'sn' })

    expect(result.auctions).toEqual([])
    expect(result.platformsSucceeded).toEqual([])
  })
})
