import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/fetch-archive', () => ({ archiveDetailCapture: vi.fn(async () => undefined) }))

const SITEMAP = `<urlset>
<url><loc>https://eauction24.gr/auction/1</loc></url>
<url><loc>https://eauction24.gr/auction/2</loc></url>
</urlset>`
const DETAIL = `<script type="application/ld+json">${JSON.stringify({
  '@type': 'RealEstateListing',
  name: 'Διαμέρισμα',
})}</script>`

// JSON-LD whose name is not a string — clean() would throw a TypeError on it.
const MALFORMED_DETAIL = `<script type="application/ld+json">${JSON.stringify({
  '@type': 'RealEstateListing',
  name: { el: 'Διαμέρισμα' },
})}</script>`

function stubEauction(
  detailStatus: (id: string, call: number) => number,
  detailBody: (id: string) => string = () => DETAIL,
): void {
  const calls = new Map<string, number>()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('.xml')) return new Response(SITEMAP)
    const id = url.split('/').pop()!
    const call = (calls.get(id) ?? 0) + 1
    calls.set(id, call)
    const status = detailStatus(id, call)
    return status === 200 ? new Response(detailBody(id)) : new Response('', { status })
  }))
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('eauction24 fetchAllListings', () => {
  it('reports the run as incomplete when a detail page fails', async () => {
    stubEauction((id) => (id === '2' ? 403 : 200))
    const { fetchAllListings } = await import('./list')

    const result = await fetchAllListings('gr-eauction24')

    expect(result.auctions.map((a) => a.externalId)).toEqual(['1'])
    expect(result.complete).toBe(false)
  })

  it.each([404, 410])('treats a detail page answering %i as a withdrawn lot, not a failure', async (status) => {
    stubEauction((id) => (id === '2' ? status : 200))
    const { fetchAllListings } = await import('./list')

    const result = await fetchAllListings('gr-eauction24')

    expect(result.auctions.map((a) => a.externalId)).toEqual(['1'])
    expect(result.complete).toBe(true)
  })

  it('retries a rate-limited detail page instead of dropping the lot', async () => {
    stubEauction((id, call) => (id === '2' && call === 1 ? 429 : 200))
    const { fetchAllListings } = await import('./list')

    const result = await fetchAllListings('gr-eauction24')

    expect(result.auctions.map((a) => a.externalId)).toEqual(['1', '2'])
    expect(result.complete).toBe(true)
  })
  it('drops only the lot whose JSON-LD fails to parse', async () => {
    stubEauction(() => 200, (id) => (id === '2' ? MALFORMED_DETAIL : DETAIL))
    const { fetchAllListings } = await import('./list')

    const result = await fetchAllListings('gr-eauction24')

    expect(result.auctions.map((a) => a.externalId)).toEqual(['1'])
  })

  it('fails the crawl when archiving a detail page fails', async () => {
    stubEauction(() => 200)
    const { archiveDetailCapture } = await import('~/server/utils/fetch-archive')
    vi.mocked(archiveDetailCapture).mockRejectedValueOnce(new Error('blob store full'))
    const { fetchAllListings } = await import('./list')

    await expect(fetchAllListings('gr-eauction24')).rejects.toThrow('blob store full')
  })
})
