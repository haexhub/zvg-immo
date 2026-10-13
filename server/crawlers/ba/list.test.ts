import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAllListings } from './list'
import { pravosudijeCrawler } from './index'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function listItem(id: number, total: unknown): Record<string, unknown> {
  return { id, naslov: `Zaključak o prodaji ${id}`, datumProdaje: '2026-11-01', insId: 1, institucija: 'Sud', total }
}

/** Serves list pages from `pages` (1-based); every detail call answers 500. */
function stubApi(pages: Record<number, () => Response>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const page = /[?&]page=(\d+)/.exec(url)?.[1]
    if (url.includes('/sudske-prodaje') && page) return pages[Number(page)]?.() ?? jsonResponse([], 404)
    return jsonResponse({}, 500)
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchAllListings', () => {
  it('rejects a list page without a numeric total instead of crawling page 1 only', async () => {
    stubApi({ 1: () => jsonResponse([listItem(1, undefined)]) })
    await expect(fetchAllListings('pravosudje-ba')).rejects.toThrow(/invalid total/)
  })

  it('reports the run incomplete when a later page fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubApi({
      1: () => jsonResponse([listItem(1, 120)]),
      2: () => jsonResponse([listItem(2, 120)]),
      3: () => jsonResponse({}, 429),
    })
    const result = await fetchAllListings('pravosudje-ba')
    expect(result.auctions.map((a) => a.externalId)).toEqual(['1', '2'])
    expect(result.total).toBe(120)
    expect(result.complete).toBe(false)
  })

  it('reports a fully paged run complete', async () => {
    stubApi({
      1: () => jsonResponse([listItem(1, 60)]),
      2: () => jsonResponse([listItem(2, 60)]),
    })
    const result = await fetchAllListings('pravosudje-ba')
    expect(result.auctions).toHaveLength(2)
    expect(result.complete).toBe(true)
  })
})

describe('ba crawl', () => {
  it('keeps the fetched pages but reports no success when a list page failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubApi({
      1: () => jsonResponse([listItem(1, 60)]),
      2: () => jsonResponse({}, 500),
    })

    const result = await pravosudijeCrawler.crawl({ region: 'all' })

    expect(result.auctions).toHaveLength(1)
    expect(result.platformsSucceeded).toEqual([])
  })
})
