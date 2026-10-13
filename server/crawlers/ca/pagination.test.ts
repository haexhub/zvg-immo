import { afterEach, describe, expect, it, vi } from 'vitest'
import { INDEX_URL } from './constants'
import { fetchAllListings } from './list'

const SALE_URL = 'https://www.ontariotaxsales.ca/tax-sales/fort-erie-2026-07-15/'

function stubFetch(salePage: Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    url === INDEX_URL ? new Response(`<a href="${SALE_URL}">Fort Erie</a>`) : salePage,
  ))
}

describe('fetchAllListings', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports the run complete when every sale page loaded', async () => {
    stubFetch(new Response('<body></body>'))

    expect((await fetchAllListings('ca-ontariotaxsales')).complete).toBe(true)
  })

  it('reports the run incomplete when a sale page fails to load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch(new Response('', { status: 503 }))

    expect((await fetchAllListings('ca-ontariotaxsales')).complete).toBe(false)
  })
})
