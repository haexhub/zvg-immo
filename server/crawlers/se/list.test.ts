import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAllListings, extractListingIds, extractNextStartAtHit, extractTotalHits } from './list'

const BASE = 'https://auktionstorget.kronofogden.se'

function searchHtml(ids: string[], total: number, nextStartAtHit?: number): string {
  const links = ids
    .map((id) => `<a href="/${id}.html" class="h3rubrik" id="svlrid_${id}">Listing ${id}</a>`)
    .join('\n')
  const next = nextStartAtHit != null
    ? `<a href="?query=*&amp;startAtHit=${nextStartAtHit}">Visa nästa 10 &raquo;</a>`
    : ''
  return `${links}<span>Visar 1-10 av totalt ${total} träffar</span>${next}`
}

function detailHtml(id: string): string {
  return `
    <h3 id="h-Adress">Adress</h3><p class="normal">Testgatan ${id}</p>
    <h3 id="h-Kommun">Kommun</h3><p class="normal">Test kommun</p>
    <h2 id="h-Upplatelseform">Upplatelseform</h2><p class="normal">Äganderätt.</p>
    <div id="datumet">2026-08-27</div>
  `
}

function detailHtmlWithShowingAddress(id: string): string {
  return `
    <h3 id="h-Adress">Adress</h3><p class="normal">Kvarnbyn 76, Burträsk</p>
    <h3 id="h-Kommun">Kommun</h3><p class="normal">Skellefteå kommun</p>
    <h3 id="h-Arendenummer">Ärendenummer</h3><p class="normal">F-${id}-25</p>
    <h2 id="h-Upplatelseform">Upplatelseform</h2><p class="normal">Äganderätt.</p>
    <div id="datumet">2026-08-27</div>
    <script>
      AppRegistry.registerInitialState('booking-${id}', {"showingAddress":"Kvarnbyn 76, 93794, Burtr\\u00e4sk"});
    </script>
  `
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('extractListingIds', () => {
  it('extracts only search result listing links and drops static navigation pages', () => {
    const html = `
      <a href="/85964.html"><span>Om cookies</span></a>
      <li class="sv-search-hit">
        <a href="/101752.html" class="h3rubrik" id="svlrid_1">Kalix</a>
        <a href="/101752.html" class="h3rubrik" id="svlrid_2"><img src="/images/1.jpg"></a>
      </li>
      <li class="sv-search-hit">
        <a class="h3rubrik featured" href="/101784.html" id="svlrid_3">Burträsk</a>
      </li>
      <a href="/37688.html"><span>Visningsinformation</span></a>
    `

    expect(extractListingIds(html)).toEqual(['101752', '101784'])
  })
})

describe('extractTotalHits', () => {
  it('reads the Swedish hit counter', () => {
    expect(extractTotalHits('<span>Visar 1-10 av totalt 46 träffar</span>')).toBe(46)
  })

  it('returns null when the counter is absent', () => {
    expect(extractTotalHits('<main>No counter</main>')).toBeNull()
  })
})

describe('extractNextStartAtHit', () => {
  it('returns the next pagination offset', () => {
    const html = '<a href="?query=*&amp;startAtHit=10">Visa nästa 10 &raquo;</a>'
    expect(extractNextStartAtHit(html, 0)).toBe(10)
  })

  it('returns null on the last page', () => {
    const html = '<span>Visar 41-46 av totalt 46 träffar</span>'
    expect(extractNextStartAtHit(html, 40)).toBeNull()
  })
})

describe('fetchAllListings', () => {
  it('walks paginated search pages, uses total-hit fallback and dedupes source results', async () => {
    const requestedUrls: string[] = []
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      requestedUrls.push(href)

      if (href === `${BASE}/Sokfastigheterbostadsratter.html?query=*`) {
        return new Response(searchHtml(['101001'], 12), { status: 200 })
      }
      if (href === `${BASE}/Sokfastigheterbostadsratter.html?query=*&startAtHit=10`) {
        return new Response(searchHtml(['101002'], 12), { status: 200 })
      }
      if (href === `${BASE}/22660.html?query=*`) {
        return new Response(searchHtml(['101002', '101003'], 3, 10), { status: 200 })
      }
      if (href === `${BASE}/22660.html?query=*&startAtHit=10`) {
        return new Response(searchHtml([], 3), { status: 200 })
      }

      const id = href.match(/\/(\d+)\.html$/)?.[1]
      if (id) return new Response(detailHtml(id), { status: 200 })
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchAllListings('se-kronofogden')

    expect(result.auctions.map((a) => a.externalId)).toEqual(['101001', '101002', '101003'])
    expect(result.total).toBe(3)
    expect(requestedUrls).toContain(`${BASE}/Sokfastigheterbostadsratter.html?query=*&startAtHit=10`)
    expect(requestedUrls).toContain(`${BASE}/22660.html?query=*&startAtHit=10`)
    expect(requestedUrls.filter((url) => url === `${BASE}/101002.html`)).toHaveLength(1)
  })

  it('keeps successful search-source results when another source fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.startsWith(`${BASE}/Sokfastigheterbostadsratter.html`)) {
        return new Response('upstream error', { status: 503 })
      }
      if (href === `${BASE}/22660.html?query=*`) {
        return new Response(searchHtml(['101003'], 1), { status: 200 })
      }
      const id = href.match(/\/(\d+)\.html$/)?.[1]
      if (id) return new Response(detailHtml(id), { status: 200 })
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchAllListings('se-kronofogden')

    expect(result.auctions.map((a) => a.externalId)).toEqual(['101003'])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('uses the embedded showing address with postcode when Kronofogden exposes it', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href === `${BASE}/Sokfastigheterbostadsratter.html?query=*`) {
        return new Response(searchHtml(['101784'], 1), { status: 200 })
      }
      if (href === `${BASE}/22660.html?query=*`) {
        return new Response(searchHtml([], 0), { status: 200 })
      }
      if (href === `${BASE}/101784.html`) {
        return new Response(detailHtmlWithShowingAddress('101784'), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchAllListings('se-kronofogden')

    expect(result.auctions[0]?.address).toBe('Kvarnbyn 76, 937 94 Burträsk')
  })
})
