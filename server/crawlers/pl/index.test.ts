import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import type { ParseResult } from './list'

const fetchListPage = vi.fn()
vi.mock('./list', () => ({ fetchListPage }))
vi.mock('./detail', () => ({ enrichOne: vi.fn() }))

function auction(externalId: string): Auction {
  return {
    platform: 'pl-komornik',
    country: 'pl',
    region: 'Mazowieckie',
    externalId,
    caseNumber: '',
    authority: '',
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
  fetchListPage.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('pl crawl', () => {
  it('reports success on a normal single-page result', async () => {
    const { plKomornikCrawler } = await import('./index')
    const page: ParseResult = { auctions: [auction('1')], currentPage: 1, lastPage: 1, hasNextPage: false }
    fetchListPage.mockResolvedValue(page)

    const result = await plKomornikCrawler.crawl({ region: 'all' })

    expect(result.platformsSucceeded).toEqual(['pl-komornik'])
  })

  it('does not report success when pagination hits the safety cap', async () => {
    const { plKomornikCrawler } = await import('./index')
    // Every page still claims more pages exist — the loop only stops via the
    // MAX_PAGES safety cap, which must mark the crawl incomplete.
    const page: ParseResult = { auctions: [auction('x')], currentPage: 1, lastPage: 999, hasNextPage: true }
    fetchListPage.mockResolvedValue(page)

    const result = await plKomornikCrawler.crawl({ region: 'all' })

    expect(result.platformsSucceeded).toEqual([])
  })
})
