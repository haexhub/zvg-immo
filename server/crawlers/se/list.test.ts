import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAllListings,
  fetchListingById,
  extractKronofogdenPhotoUrls,
  extractListingIds,
  extractNextStartAtHit,
  extractTotalHits,
} from './list'

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

function detailHtmlWithGallery(id: string): string {
  return `
    <h3 id="h-Adress">Adress</h3><p class="normal">Testgatan ${id}</p>
    <h3 id="h-Kommun">Kommun</h3><p class="normal">Test kommun</p>
    <h2 id="h-Upplatelseform">Upplatelseform</h2><p class="normal">Äganderätt.</p>
    <div id="datumet">2026-08-27</div>
    <img src="/images/18.static/1/logotyp-footer.png">
    <div id="galleria">
      <img style="display:none" src="/images/200.abc/1782824511083/Bild%201.jpg">
      <img style="display:none" src="/images/200.def/1782824511166/Bild%202.jpg">
      <img style="display:none" src="/images/200.abc/1782824511083/Bild%201.jpg">
    </div>
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

function detailHtmlWithFarmArea(id: string): string {
  return `
    <h3 id="h-Adress">Adress</h3><p class="normal">Åse 360, Trångsviken</p>
    <h3 id="h-Kommun">Kommun</h3><p class="normal">Krokoms kommun</p>
    <h3 id="h-Arendenummer">Ärendenummer</h3><p class="normal">F-${id}-25</p>
    <h3 id="h-Storlek">Storlek</h3><p class="normal">3 rum, 80 kvm<br>3 rum och kök</p>
    <h2 id="h-Taxeringskod">Taxeringskod</h2><p class="normal">Lantbruksenhet, bebyggd (120).</p>
    <div id="datumet">2026-09-03</div>
    <div class="sv-text-portlet">
      <div id="Ingress"><!-- Ingress --></div>
      <div class="sv-text-portlet-content">
        <p class="brodtextxingress">Fastighet bestående av ett skifte med en areal om ca 18,1 ha, varav ca 14,6 ha avser produktiv skogsmark med ett virkesförråd om 2 280 m3sk, ca 1,8 ha tomtmark, ca 1,4 ha betesmark samt ca 0,5 ha övrig mark.</p>
      </div>
    </div>
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

describe('extractKronofogdenPhotoUrls', () => {
  it('extracts the object gallery images and ignores chrome/sidebar artwork', () => {
    const html = `
      <img src="/images/18.static/1/logotyp-footer.png">
      <div id="galleria">
        <img style="display:none" src="/images/200.728f87/1782824511083/Bild%201.jpg">
        <img style="display:none" src="/images/200.728f88/1782824511166/Bild%202.jpg">
      </div>
      <img src="/images/18.static/1/auktionstorget_puff_lana.jpg">
    `

    expect(extractKronofogdenPhotoUrls(html)).toEqual([
      `${BASE}/images/200.728f87/1782824511083/Bild%201.jpg`,
      `${BASE}/images/200.728f88/1782824511166/Bild%202.jpg`,
    ])
  })

  it('does not truncate the gallery at nested divs', () => {
    const html = `
      <div id="galleria">
        <div class="slide">
          <img src="/images/200.aaa/1782824511083/Bild%201.jpg">
        </div>
        <div class="slide">
          <img src="/images/200.bbb/1782824511166/Bild%202.jpg">
        </div>
      </div>
    `

    expect(extractKronofogdenPhotoUrls(html)).toEqual([
      `${BASE}/images/200.aaa/1782824511083/Bild%201.jpg`,
      `${BASE}/images/200.bbb/1782824511166/Bild%202.jpg`,
    ])
  })

  it('falls back to the largest Bild srcset candidates when no galleria block exists', () => {
    const html = `
      <img alt="" srcset="/images/18.abc/1/x160p/Bild%201.jpg 160w, /images/18.abc/1/Bild%201.jpg 1024w" src="/images/18.abc/1/Bild%201.jpg">
      <img src="/images/18.static/1/Auktion_puffmellan_dorr.jpg">
    `

    expect(extractKronofogdenPhotoUrls(html)).toEqual([
      `${BASE}/images/18.abc/1/Bild%201.jpg`,
    ])
  })

  it('accepts any filename inside the galleria block, not just "BildN"', () => {
    // Real Kronofogden listings use inconsistent per-case filenames: plain
    // numeric ("1.jpg") or hyphenated ("Bild-001.jpg") — neither matched the
    // old "bild" + optional-whitespace + digits pattern, which silently
    // dropped every photo for these listings.
    const html = `
      <div id="galleria">
        <img style="display:none" src="/images/200.aaa/1781605779295/1.jpg">
        <img style="display:none" src="/images/200.bbb/1781594534027/Bild-001.jpg">
      </div>
    `

    expect(extractKronofogdenPhotoUrls(html)).toEqual([
      `${BASE}/images/200.aaa/1781605779295/1.jpg`,
      `${BASE}/images/200.bbb/1781594534027/Bild-001.jpg`,
    ])
  })

  it('stops at the galleria close tag instead of sweeping up later page images', () => {
    const html = `
      <div id="galleria">
        <img src="/images/200.aaa/1781605779295/1.jpg">
      </div>
      <img src="/images/18.static/1/2.jpg">
    `

    expect(extractKronofogdenPhotoUrls(html)).toEqual([
      `${BASE}/images/200.aaa/1781605779295/1.jpg`,
    ])
  })

  it('recognizes closing div tags with whitespace before the angle bracket', () => {
    const html = `
      <div id="galleria">
        <img src="/images/200.aaa/1781605779295/1.jpg">
      </div >
      <img src="/images/18.static/1/2.jpg">
    `

    expect(extractKronofogdenPhotoUrls(html)).toEqual([
      `${BASE}/images/200.aaa/1781605779295/1.jpg`,
    ])
  })

  it('an unclosed galleria div is auto-closed at end of document, like a browser would', () => {
    // A real HTML parser doesn't "fail to find" a missing close tag the way
    // the old hand-rolled regex could — per the HTML5 spec it auto-closes
    // the element at EOF, so both images still count as inside the gallery.
    const html = `
      <div id="galleria">
        <img src="/images/200.aaa/1781605779295/1.jpg">
        <img src="/images/200.bbb/1781594534027/Bild-002.jpg">
    `

    expect(extractKronofogdenPhotoUrls(html)).toEqual([
      `${BASE}/images/200.aaa/1781605779295/1.jpg`,
      `${BASE}/images/200.bbb/1781594534027/Bild-002.jpg`,
    ])
  })

  it('preserves DOM order when a src candidate precedes a srcset candidate', () => {
    const html = `
      <div id="galleria">
        <img src="/images/200.aaa/1781605779295/1.jpg">
        <img srcset="/images/200.bbb/1781594534027/2.jpg 1024w">
      </div>
    `

    expect(extractKronofogdenPhotoUrls(html)).toEqual([
      `${BASE}/images/200.aaa/1781605779295/1.jpg`,
      `${BASE}/images/200.bbb/1781594534027/2.jpg`,
    ])
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

  it('stores the total farm area as source land area', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href === `${BASE}/Sokfastigheterbostadsratter.html?query=*`) {
        return new Response(searchHtml(['101765'], 1), { status: 200 })
      }
      if (href === `${BASE}/22660.html?query=*`) {
        return new Response(searchHtml([], 0), { status: 200 })
      }
      if (href === `${BASE}/101765.html`) {
        return new Response(detailHtmlWithFarmArea('2703'), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchAllListings('se-kronofogden')

    expect(result.auctions[0]?.sourceLandAreaSqm).toBe(181000)
    expect(result.auctions[0]?.sourceLivingAreaSqm).toBe(80)
    expect(result.auctions[0]?.sourceRooms).toBe(3)
  })

  it('stores Kronofogden gallery URLs for the native photo pipeline', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href === `${BASE}/Sokfastigheterbostadsratter.html?query=*`) {
        return new Response(searchHtml(['101843'], 1), { status: 200 })
      }
      if (href === `${BASE}/22660.html?query=*`) {
        return new Response(searchHtml([], 0), { status: 200 })
      }
      if (href === `${BASE}/101843.html`) {
        return new Response(detailHtmlWithGallery('101843'), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchAllListings('se-kronofogden')

    expect(result.auctions[0]?.thumbnailUrl).toBe(`${BASE}/images/200.abc/1782824511083/Bild%201.jpg`)
    expect(result.auctions[0]?.photoUrls).toEqual([
      `${BASE}/images/200.abc/1782824511083/Bild%201.jpg`,
      `${BASE}/images/200.def/1782824511166/Bild%202.jpg`,
    ])
    expect(result.auctions[0]?.photoCount).toBe(2)
  })
})

describe('fetchListingById', () => {
  it('fetches and maps a single Kronofogden detail page without walking search pages', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href === `${BASE}/101743.html`) {
        return new Response(detailHtmlWithShowingAddress('101743'), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const auction = await fetchListingById('101743', 'se-kronofogden')

    expect(auction?.externalId).toBe('101743')
    expect(auction?.address).toBe('Kvarnbyn 76, 937 94 Burträsk')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects non-numeric ids before fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchListingById('../nope', 'se-kronofogden')).resolves.toBeNull()

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
