import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { enrichOne } from './detail'

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } })
}

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

describe('enrichOne', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fills title, description, photos and the catalog attachment', async () => {
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
        excludeFromPhotoMining: true,
      },
    ])
  })

  it('leaves description null and keeps the existing thumbnail when the detail page has no extra content', async () => {
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
})
