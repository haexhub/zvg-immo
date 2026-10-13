import { afterEach, describe, expect, it, vi } from 'vitest'
import { crawlCourt } from './list'

const COURT = { slug: 'karlsruhe', name: 'Karlsruhe' }

function inertiaHtml(lastPage: number, ids: number[]): string {
  const page = {
    props: {
      auctions: {
        data: ids.map((id) => ({ id, title: `Objekt ${id}`, link: `/objekt/${id}`, facts: [], cancelled: false })),
        meta: { current_page: 1, last_page: lastPage, total: ids.length * lastPage },
      },
    },
  }
  return `<div id="app" data-page="${JSON.stringify(page).replace(/"/g, '&quot;')}"></div>`
}

describe('crawlCourt', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps the listings of every page', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      new Response(inertiaHtml(2, [url.includes('page=2') ? 2 : 1])),
    ))
    const result = await crawlCourt(COURT, 'zvbawu')
    expect(result.auctions.map((a) => a.externalId)).toEqual(['1', '2'])
  })

  it('rejects instead of reporting an empty court when the first page fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })))
    await expect(crawlCourt(COURT, 'zvbawu')).rejects.toThrow(/HTTP 502/)
  })

  it('rejects instead of returning a truncated court when a follow-up page fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('page=2') ? Promise.reject(new TypeError('fetch failed')) : new Response(inertiaHtml(2, [1])),
    ))
    await expect(crawlCourt(COURT, 'zvbawu')).rejects.toMatchObject({ cause: expect.any(TypeError) })
  })
})
