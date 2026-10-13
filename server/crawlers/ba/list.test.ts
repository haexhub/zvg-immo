import { afterEach, describe, expect, it, vi } from 'vitest'
import { pravosudijeCrawler } from './index'

const fetchMock = vi.fn(async (url: string) => {
  if (url.includes('page=1&')) {
    return Response.json([{ id: 1, naslov: 'Zaključak o prodaji 1', datumProdaje: '', insId: 1, institucija: 'Sud', total: 60 }])
  }
  // Page 2 of the list (and every detail call) fails.
  return new Response('', { status: 500 })
})

describe('ba crawl', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the fetched pages but reports no success when a list page failed', async () => {
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await pravosudijeCrawler.crawl({ region: 'all' })

    expect(result.auctions).toHaveLength(1)
    expect(result.platformsSucceeded).toEqual([])
  })
})
