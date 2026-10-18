import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'

const crawlCourt = vi.fn()
vi.mock('./list', () => ({ crawlCourt }))
vi.mock('./detail', () => ({ enrichInBatches: vi.fn() }))

function auction(externalId: string): Auction {
  return {
    platform: 'zvbawu',
    country: 'de',
    region: 'Baden-Württemberg',
    externalId,
    caseNumber: '',
    authority: 'AG Karlsruhe',
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
  crawlCourt.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('zvbawu crawl', () => {
  it('reports success when every court crawl fulfills', async () => {
    const { zvbawuCrawler } = await import('./index')
    crawlCourt.mockResolvedValue({ totalReported: 1, auctions: [auction('1')] })

    const result = await zvbawuCrawler.crawl({ region: 'bw', enrichDetails: false })

    expect(result.platformsSucceeded).toEqual(['zvbawu'])
  })

  it('does not report success when a single court crawl fails, even though the other 34 still return listings', async () => {
    const { zvbawuCrawler } = await import('./index')
    crawlCourt.mockResolvedValue({ totalReported: 1, auctions: [auction('1')] })
    crawlCourt.mockRejectedValueOnce(new Error('court unreachable'))

    const result = await zvbawuCrawler.crawl({ region: 'bw', enrichDetails: false })

    // The other courts' listings still show up — only the success verdict is
    // withheld, matching the NOT-EXISTS "when uncertain, keep showing it"
    // philosophy of the search filter.
    expect(result.auctions.length).toBeGreaterThan(0)
    expect(result.platformsSucceeded).toEqual([])
  })

  it('ignores a [0, 0] position from the detail payload and keeps what was there', async () => {
    const { enrichInBatches } = await import('./detail')
    const { zvbawuCrawler } = await import('./index')
    const detail = (latlng: [number, number] | null) => ({
      description: null, attachments: [], photoCount: 0, thumbnailUrl: null, pdfUrl: null,
      pdfUrlOriginal: null, pdfUrlUpstream: null, cancelled: false, caseNumber: null, latlng,
    })
    const run = async (latlng: [number, number] | null, item: Auction) => {
      vi.mocked(enrichInBatches).mockImplementationOnce((async (auctions: Auction[], apply: (a: Auction, d: unknown) => void) => {
        apply(auctions[0]!, detail(latlng))
        return { errors: 0 }
      }) as never)
      await zvbawuCrawler.enrichOne!(item)
    }

    const unlocated = auction('1')
    await run([0, 0], unlocated)
    expect(unlocated.lat ?? null).toBeNull()

    const located = auction('2')
    await run([48.0079, 7.8107], located)
    expect(located).toMatchObject({ lat: 48.0079, lng: 7.8107 })
  })
})
