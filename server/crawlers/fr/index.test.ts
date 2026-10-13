import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const archiveDetailCapture = vi.fn()
vi.mock('~/server/utils/fetch-archive', () => ({ archiveDetailCapture }))

const LIST_WITH_ONE_ITEM = `
<ul class="AdResults"><li><a class="Ad" href="/annonce/1/2/3/12345.html">
  <span class="Location"><span class="City">Rennes</span></span>
  <span class="Description"><span class="Name">Maison</span></span>
</a></li></ul>
<input name="total" value="1"><input name="limit" value="5">`
const EMPTY_LIST = '<ul class="AdResults"></ul><input name="total" value="0"><input name="limit" value="5">'
const DETAIL = '<div class="AdContent"><span class="Number">12345</span></div>'

function stubLicitor(failingRegion: string | null): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (failingRegion && url.includes(failingRegion)) return new Response('gone', { status: 404 })
    if (url.includes('12345.html')) return new Response(DETAIL)
    if (url.includes('bretagne-grand-ouest')) return new Response(LIST_WITH_ONE_ITEM)
    return new Response(EMPTY_LIST)
  }))
}

beforeEach(() => {
  archiveDetailCapture.mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())

describe('licitor crawl', () => {
  it('reports success when every grande région was fetched', async () => {
    stubLicitor(null)
    const { licitorCrawler } = await import('./index')

    const result = await licitorCrawler.crawl({ region: 'all' })

    expect(result.auctions.map((a) => a.externalId)).toEqual(['12345'])
    expect(result.platformsSucceeded).toEqual(['fr-licitor'])
  })

  it('keeps the other regions\' listings but withholds success when one région fails', async () => {
    stubLicitor('paris-et-ile-de-france')
    const { licitorCrawler } = await import('./index')

    const result = await licitorCrawler.crawl({ region: 'all' })

    expect(result.auctions.map((a) => a.externalId)).toEqual(['12345'])
    expect(result.platformsSucceeded).toEqual([])
  })

  it('fails the crawl instead of hiding an archive persistence failure', async () => {
    stubLicitor(null)
    archiveDetailCapture.mockRejectedValue(new Error('ENOSPC'))
    const { licitorCrawler } = await import('./index')

    await expect(licitorCrawler.crawl({ region: 'all' })).rejects.toThrow('ENOSPC')
  })
})
