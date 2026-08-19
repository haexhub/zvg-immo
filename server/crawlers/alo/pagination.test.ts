import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAloPage } from './fetch'
import { ALO_OBLASTI } from './constants'
import { fetchCategoryListings, fetchListPage } from './list'

vi.mock('./fetch', () => ({ fetchAloPage: vi.fn() }))
// Shrunk so the runaway-pagination guard is reachable without mocking 700 pages.
vi.mock('./constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./constants')>()),
  MAX_PAGES: 3,
}))

const mockFetch = vi.mocked(fetchAloPage)
const SOFIA = ALO_OBLASTI[0]!

/** Minimal card markup — parseListPage keys off `id="adrows_<id>"` plus the
 *  title anchor wrapping an <h3>. */
function listPage(...ids: string[]): Response {
  const cards = ids
    .map(
      (id) =>
        `<div id="adrows_${id}"><a href="/obiava-${id}"><h3>Обява ${id}</h3></a>` +
        `<span class="ads-params-multi" title="Цена"><span class="price_nowrap">100 000 €</span></span></div>`,
    )
    .join('')
  return new Response(`<html><body>${cards}</body></html>`)
}

beforeEach(() => mockFetch.mockReset())
afterEach(() => vi.restoreAllMocks())

describe('fetchListPage', () => {
  it('reads a 404 past page 1 as end-of-pagination rather than an error', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 404 }))
    await expect(fetchListPage('kashti-vili', '22', 2)).resolves.toBeNull()
  })

  it('throws on a 404 for page 1, which means an unknown region_id or category slug', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 404 }))
    await expect(fetchListPage('kashti-vili', '22', 1)).rejects.toThrow('HTTP 404')
  })

  it('throws on a non-404 error status so the crawl reports the failure', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 403 }))
    await expect(fetchListPage('kashti-vili', '22', 2)).rejects.toThrow('HTTP 403')
  })
})

describe('fetchCategoryListings', () => {
  it('walks pages until one 404s and de-duplicates ids repeated across pages by VIP interleaving', async () => {
    mockFetch
      .mockResolvedValueOnce(listPage('1', '2'))
      .mockResolvedValueOnce(listPage('2', '3'))
      .mockResolvedValueOnce(new Response('', { status: 404 }))

    const auctions = await fetchCategoryListings('apartamenti-stai', SOFIA)

    expect(auctions.map((a) => a.externalId)).toEqual(['1', '2', '3'])
    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(mockFetch.mock.calls.map((c) => c[0])).toEqual([
      'https://www.alo.bg/obiavi/imoti-prodajbi/apartamenti-stai/?region_id=22&page=1',
      'https://www.alo.bg/obiavi/imoti-prodajbi/apartamenti-stai/?region_id=22&page=2',
      'https://www.alo.bg/obiavi/imoti-prodajbi/apartamenti-stai/?region_id=22&page=3',
    ])
  })

  it('stops on the first page that parses to no cards', async () => {
    mockFetch.mockResolvedValueOnce(listPage('1')).mockResolvedValueOnce(listPage())

    expect(await fetchCategoryListings('apartamenti-stai', SOFIA)).toHaveLength(1)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the pages already walked when a later page stays broken', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetch
      .mockResolvedValueOnce(listPage('1', '2'))
      .mockResolvedValueOnce(new Response('', { status: 403 }))

    const auctions = await fetchCategoryListings('apartamenti-stai', SOFIA)

    expect(auctions.map((a) => a.externalId)).toEqual(['1', '2'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 403'))
  })

  it('still fails hard when the walk yielded nothing at all, rather than reporting zero listings', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 403 }))

    await expect(fetchCategoryListings('apartamenti-stai', SOFIA)).rejects.toThrow('HTTP 403')
  })

  it('warns instead of silently truncating when the page cap cuts the walk short', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let page = 0
    mockFetch.mockImplementation(async () => listPage(`id-${++page}`))

    const auctions = await fetchCategoryListings('apartamenti-stai', SOFIA)

    expect(auctions).toHaveLength(3)
    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MAX_PAGES'))
  })
})
