import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'

const fetchEndpoint = vi.fn()
vi.mock('./list', () => ({ fetchEndpoint }))

function auction(externalId: string): Auction {
  return {
    platform: 'cz-portaldrazeb',
    country: 'cz',
    region: 'Praha',
    externalId,
    caseNumber: '',
    authority: 'Test Auctioneer',
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
  fetchEndpoint.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('cz crawl', () => {
  it('reports success when every endpoint answers', async () => {
    const { czPortaldrazebCrawler } = await import('./index')
    fetchEndpoint.mockResolvedValue([auction('1')])

    const result = await czPortaldrazebCrawler.crawl({ region: 'all' })

    expect(result.platformsSucceeded).toEqual(['cz-portaldrazeb'])
  })

  it('does not report success when one required endpoint fails, even though the others still return listings', async () => {
    const { czPortaldrazebCrawler } = await import('./index')
    fetchEndpoint
      .mockResolvedValueOnce([auction('1')])
      .mockRejectedValueOnce(new Error('CZ list fetch failed: 503'))

    const result = await czPortaldrazebCrawler.crawl({ region: 'all' })

    // The successful endpoint's listings still show up — only the
    // success verdict is withheld, so the working half stays visible.
    expect(result.auctions).toHaveLength(1)
    expect(result.platformsSucceeded).toEqual([])
  })
})
