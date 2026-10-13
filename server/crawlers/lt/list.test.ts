import { afterEach, describe, expect, it, vi } from 'vitest'
import { eaukcionaiCrawler } from './index'
import { fetchAllListings } from './list'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function row(id: number): string {
  return `<li><div class="top_block"><h2 class="no"><a href="?id=${id}&number=${id}">${id}</a></h2></div></li>`
}

// parsePage reads a page with 20+ rows as "more pages follow".
function listPage(ids: number[]): Response {
  return new Response(`<ul class="bid_list">${ids.map(row).join('')}</ul>`, { status: 200 })
}

const FULL_PAGE = Array.from({ length: 20 }, (_, i) => i + 1)

describe('fetchAllListings', () => {
  afterEach(() => mockFetch.mockReset())

  it('reports a walk ending on a short page as complete', async () => {
    mockFetch.mockResolvedValueOnce(listPage(FULL_PAGE)).mockResolvedValueOnce(listPage([21]))

    const { auctions, complete } = await fetchAllListings('lt-eaukcionai')

    expect(auctions).toHaveLength(21)
    expect(complete).toBe(true)
  })

  it('keeps the walked pages but reports the run incomplete when a follow-up page fails', async () => {
    mockFetch.mockResolvedValueOnce(listPage(FULL_PAGE)).mockResolvedValueOnce(new Response('', { status: 503 }))

    const { auctions, complete } = await fetchAllListings('lt-eaukcionai')

    expect(auctions).toHaveLength(20)
    expect(complete).toBe(false)
  })

  it('leaves the platform out of platformsSucceeded for an incomplete crawl', async () => {
    mockFetch.mockResolvedValueOnce(listPage(FULL_PAGE)).mockResolvedValueOnce(new Response('', { status: 503 }))

    const result = await eaukcionaiCrawler.crawl({ region: 'all' })

    expect(result.auctions).toHaveLength(20)
    expect(result.platformsSucceeded).toEqual([])
  })
})
