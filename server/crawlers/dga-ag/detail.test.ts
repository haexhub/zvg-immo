import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import type { enrichOne as EnrichOne, fetchFreshObjectDocumentUrl as FetchFreshObjectDocumentUrl } from './detail'

let enrichOne: typeof EnrichOne
let fetchFreshObjectDocumentUrl: typeof FetchFreshObjectDocumentUrl

// The session module caches its login across calls at module scope
// (session.ts); resetting modules per test keeps that cache from leaking
// between tests that configure different credentials/mock responses.
beforeEach(async () => {
  vi.resetModules()
  ;({ enrichOne, fetchFreshObjectDocumentUrl } = await import('./detail'))
})

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } })
}

function withSetCookie(body: string, cookies: string[]): Response {
  const headers = new Headers({ 'Content-Type': 'text/html' })
  for (const c of cookies) headers.append('set-cookie', c)
  return new Response(body, { status: 200, headers })
}

const LOGIN_HTML = `
<html><body>
<form action="/login.html?tx_felogin_login%5Baction%5D=login&tx_felogin_login%5Bcontroller%5D=Login&cHash=abc123" method="post">
<input type="hidden" name="__RequestToken" value="token-xyz" >
<input type="submit" value="" name="submit" />
</form>
</body></html>
`

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'dga-ag',
    country: 'de',
    region: 'Sachsen',
    externalId: 'S26-01-001',
    caseNumber: '',
    authority: 'SGA AG',
    title: null,
    address: 'Musterstraße 1, 01067 Dresden',
    marketValueEur: 125000,
    marketValueText: '125.000 €',
    startingBid: 125000,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: 'https://www.dga-ag.de/immobilie-ersteigern/immobilie-suchen-und-finden/objekt/S26-01-001.html',
    pdfUrlUpstream: null,
    detailUrlUpstream: 'https://www.dga-ag.de/immobilie-ersteigern/immobilie-suchen-und-finden/objekt/S26-01-001.html',
    attachments: [],
    description: null,
    photoCount: 1,
    thumbnailUrl: 'https://www.dga-ag.de/fileadmin/_processed_/a/b/csm_preview_x.jpg',
    lat: 51.05,
    lng: 13.74,
    ...overrides,
  }
}

const DETAIL_HTML_FULL = `
<html><head>
<meta property="og:title" content="Sonniges Reihenhaus">
<meta property="og:description" content="Immobilie kaufen ✓ Immobiliensuche ✓">
</head><body>
<div>
  <label>Lage und Umfeld dieser Immobilie</label>
  <br>
  Ruhige Wohnlage am Stadtrand von Dresden.
</div>
<div class="bs-overlay">
  <a class="zoom-handle"><img src="/fileadmin/_processed_/a/b/csm_preview_x.jpg"></a>
  <a class="zoom-handle"><img src="/fileadmin/_processed_/c/d/csm_002_y.jpg"></a>
</div>
<div class="slider-nav-thumbnails">
  <img src="/fileadmin/_processed_/a/b/csm_preview_x.jpg">
  <img src="/fileadmin/_processed_/c/d/csm_002_y.jpg">
</div>
<a href="/fileadmin/user_upload/api/kataloge/sga/S26-01.pdf#page=3">Im Katalog öffnen</a>
</body></html>
`

const DETAIL_HTML_MINIMAL = `
<html><head>
<meta property="og:title" content="Sonniges Reihenhaus">
<meta property="og:description" content="Immobilie kaufen ✓ Immobiliensuche ✓">
</head><body></body></html>
`

const DETAIL_HTML_AUTHENTICATED = `
<html><head>
<meta property="og:title" content="Sonniges Reihenhaus">
</head><body>
<a href="/fileadmin/user_upload/api/kataloge/sga/S26-01.pdf#page=3">Im Katalog öffnen</a>
<a href="/securedl/sdl-eyJhbGciOiJIUzI1NiJ9.token/S26_01_001.pdf" target="_blank">Objektunterlagen</a>
</body></html>
`

describe('enrichOne', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fills title, description, photos and the catalog attachment', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ dgaAg: { username: '', password: '' } }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(DETAIL_HTML_FULL)))
    const auction = makeAuction()
    await enrichOne(auction)

    expect(auction.title).toBe('Sonniges Reihenhaus')
    expect(auction.description).toBe('Ruhige Wohnlage am Stadtrand von Dresden.')
    expect(auction.photoUrls).toEqual([
      'https://www.dga-ag.de/fileadmin/_processed_/a/b/csm_preview_x.jpg',
      'https://www.dga-ag.de/fileadmin/_processed_/c/d/csm_002_y.jpg',
    ])
    expect(auction.photoCount).toBe(2)
    expect(auction.pdfUrl).toBe('https://www.dga-ag.de/fileadmin/user_upload/api/kataloge/sga/S26-01.pdf#page=3')
    expect(auction.attachments).toEqual([
      {
        kind: 'brochure',
        label: 'Katalog',
        filename: 'S26-01.pdf',
        sizeBytes: null,
        fileId: 'S26-01-001',
        proxyUrl: 'https://www.dga-ag.de/fileadmin/user_upload/api/kataloge/sga/S26-01.pdf#page=3',
        excludeFromDocumentMining: true,
      },
    ])
  })

  it('leaves description null and keeps the existing thumbnail when the detail page has no extra content', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ dgaAg: { username: '', password: '' } }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(DETAIL_HTML_MINIMAL)))
    const auction = makeAuction()
    await enrichOne(auction)

    expect(auction.title).toBe('Sonniges Reihenhaus')
    expect(auction.description).toBeNull()
    expect(auction.photoUrls).toBeUndefined()
    expect(auction.photoCount).toBe(1)
    expect(auction.thumbnailUrl).toBe('https://www.dga-ag.de/fileadmin/_processed_/a/b/csm_preview_x.jpg')
    expect(auction.pdfUrl).toBeNull()
    expect(auction.attachments).toEqual([])
  })

  it('does nothing when the auction has no detail URL', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const auction = makeAuction({ detailUrl: null, detailUrlUpstream: null })
    await enrichOne(auction)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('logs in and adds the per-object Objektunterlagen attachment when credentials are configured', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ dgaAg: { username: 'user@test.de', password: 'secret' } }))
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/login.html') && init?.method === 'POST') {
        return withSetCookie('<html>Herzlich Willkommen</html>', ['fe_typo_user=session456; path=/'])
      }
      if (url.includes('/login.html')) {
        return withSetCookie(LOGIN_HTML, ['__Secure-typo3nonce_x=nonce123; path=/'])
      }
      return htmlResponse(DETAIL_HTML_AUTHENTICATED)
    })
    vi.stubGlobal('fetch', fetchMock)
    const auction = makeAuction()
    await enrichOne(auction)

    expect(auction.attachments).toEqual([
      {
        kind: 'brochure',
        label: 'Katalog',
        filename: 'S26-01.pdf',
        sizeBytes: null,
        fileId: 'S26-01-001',
        proxyUrl: 'https://www.dga-ag.de/fileadmin/user_upload/api/kataloge/sga/S26-01.pdf#page=3',
        excludeFromDocumentMining: true,
      },
      {
        kind: 'appraisal',
        label: 'Objektunterlagen',
        filename: 'S26_01_001.pdf',
        sizeBytes: null,
        fileId: 'S26-01-001-unterlagen',
        proxyUrl: 'https://www.dga-ag.de/securedl/sdl-eyJhbGciOiJIUzI1NiJ9.token/S26_01_001.pdf',
      },
    ])
    // GET login.html, POST login.html, GET detail page — the detail fetch
    // carries the session cookie so the securedl link is actually present.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const detailCall = fetchMock.mock.calls[2]!
    expect((detailCall[1]?.headers as Record<string, string>).Cookie).toBe('fe_typo_user=session456')
  })
})

describe('fetchFreshObjectDocumentUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the freshly-signed securedl href from a live re-fetch', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ dgaAg: { username: 'user@test.de', password: 'secret' } }))
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/login.html') && init?.method === 'POST') {
        return withSetCookie('<html>Herzlich Willkommen</html>', ['fe_typo_user=session456; path=/'])
      }
      if (url.includes('/login.html')) {
        return withSetCookie(LOGIN_HTML, ['__Secure-typo3nonce_x=nonce123; path=/'])
      }
      return htmlResponse(DETAIL_HTML_AUTHENTICATED)
    })
    vi.stubGlobal('fetch', fetchMock)

    const url = await fetchFreshObjectDocumentUrl(
      'https://www.dga-ag.de/immobilie-ersteigern/immobilie-suchen-und-finden/objekt/S26-01-001.html',
    )
    expect(url).toBe('https://www.dga-ag.de/securedl/sdl-eyJhbGciOiJIUzI1NiJ9.token/S26_01_001.pdf')
  })

  it('returns null when no credentials are configured', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ dgaAg: { username: '', password: '' } }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(DETAIL_HTML_FULL)))
    const url = await fetchFreshObjectDocumentUrl('https://www.dga-ag.de/objekt/S26-01-001.html')
    expect(url).toBeNull()
  })
})
