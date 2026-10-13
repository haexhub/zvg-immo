import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAllListings } from './list'

const ROW = (uuid: string) => `<tr>
  <td class="__type">Nekustamais īpašums</td>
  <td class="auction-list-address"><a href="/izsole/${uuid}">Rīga</a></td>
  <td class="__state">Notiek</td>
</tr>`
const page = (uuid: string) => `<table class="auction-list"><tbody>${ROW(uuid)}</tbody></table>`

function stub(responses: Response[]): void {
  const queue = [...responses]
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? new Response(null, { status: 303, headers: { 'Set-Cookie': 'ci_session=abc; path=/' } })
      : queue.shift() ?? new Response(page('00000000-0000-0000-0000-000000000001')),
  ))
}

describe('fetchAllListings', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks the crawl incomplete when a follow-up page fails', async () => {
    stub([new Response(page('00000000-0000-0000-0000-000000000001')), new Response('', { status: 502 })])
    const result = await fetchAllListings('lv-eizsoles')
    expect(result.auctions).toHaveLength(1)
    expect(result.complete).toBe(false)
  })

  it('reports a crawl that ends on a repeated (clamped) page as complete', async () => {
    stub([new Response(page('00000000-0000-0000-0000-000000000001'))])
    const result = await fetchAllListings('lv-eizsoles')
    expect(result).toMatchObject({ total: 1, complete: true })
  })

  it('throws when the first page fails', async () => {
    stub([new Response('', { status: 503 })])
    await expect(fetchAllListings('lv-eizsoles')).rejects.toThrow(/503/)
  })
})
