import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAllListings, mapDetail } from './list'

/** Trimmed-down detail page mirroring the live markup (okid=100001, Juli 2026). */
const DETAIL_HTML = `
<h2 class="bigTitle">Korteriomand Tallinnas</h2>
<table>
  <tr><td><strong>alghind oksjonil:</strong></td><td>1 700 €</td></tr>
  <tr><td><strong>oksjoni lõpp:</strong></td><td>14.07.2026 kl 10:00</td></tr>
  <tr><td><strong>oksjoni korraldaja:</strong></td><td>Elin Vilippus, kohtutäitur</td></tr>
  <tr><td><strong>linn / vald:</strong></td><td>Tallinn</td></tr>
  <tr><td><strong>aadress:</strong></td><td>Näituse 5-2</td></tr>
  <tr>
    <td><strong>katastritunnus:</strong></td>
    <td><a href="http://xgis.maaamet.ee/ky/FindKYByT.asp?txtCU=25301:008:0015" target="_blank">25301:008:0015</a></td>
  </tr>
  <tr>
    <td><strong>reg. osa nr:</strong></td>
    <td><a href="javascript:showRegOsaNrInfoMessage()" id="login">1219008</a></td>
  </tr>
</table>
<div class="announcement-body"><p>Kohtutäitur müüb korteriomandi.</p></div>
<img src="/media/5/ad/5ad107311d4f4c20aa8bebcdaeb39d60.jpg" />
<img src="/media/6/c4/6c41ce01bb810800c0bdc26177ddf094.jpg" />
<img src="/img/logo.png" />
`

describe('mapDetail', () => {
  const auction = mapDetail('100001', DETAIL_HTML, 'ee-oksjonikeskus')!

  it('takes the caseNumber from the reg. osa nr row', () => {
    expect(auction.caseNumber).toBe('1219008')
  })

  it('prepends the katastritunnus to the description', () => {
    expect(auction.description).toBe(
      'Katasternummer: 25301:008:0015\nKohtutäitur müüb korteriomandi.',
    )
  })

  it('exposes the dopdf notice as an announcement attachment', () => {
    expect(auction.attachments).toEqual([
      {
        kind: 'announcement',
        label: 'Enampakkumise teade (PDF)',
        filename: 'oksjon-100001.pdf',
        sizeBytes: null,
        fileId: '100001',
        proxyUrl: 'https://www.oksjonikeskus.ee/oksjon/dopdf/?okid=100001',
      },
    ])
    expect(auction.pdfUrlUpstream).toBe('https://www.oksjonikeskus.ee/oksjon/dopdf/?okid=100001')
  })

  it('collects the /media/ gallery as absolute photoUrls', () => {
    expect(auction.photoUrls).toEqual([
      'https://www.oksjonikeskus.ee/media/5/ad/5ad107311d4f4c20aa8bebcdaeb39d60.jpg',
      'https://www.oksjonikeskus.ee/media/6/c4/6c41ce01bb810800c0bdc26177ddf094.jpg',
    ])
    expect(auction.photoCount).toBe(2)
    expect(auction.thumbnailUrl).toBe(
      'https://www.oksjonikeskus.ee/media/5/ad/5ad107311d4f4c20aa8bebcdaeb39d60.jpg',
    )
  })

  it('keeps mapping the pre-existing fields', () => {
    expect(auction.address).toBe('Tallinn, Näituse 5-2')
    expect(auction.marketValueEur).toBe(1700)
    expect(auction.auctionDateIso).toBe('2026-07-14T10:00:00')
    expect(auction.cancelled).toBe(false)
  })
})

describe('fetchAllListings', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function stubOksjonikeskus(opts: { page2Status: number; failingOkid?: string; failingStatus?: number }): void {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('page=1')) return new Response('<a href="?okid=100001"></a><a href="?okid=100002"></a>')
      if (url.includes('page=')) return new Response('<a href="?okid=100001"></a>', { status: opts.page2Status })
      if (opts.failingOkid && url.endsWith(`okid=${opts.failingOkid}`)) return new Response('', { status: opts.failingStatus ?? 502 })
      return new Response(DETAIL_HTML)
    }))
  }

  it('reports a complete run when every list and detail page answered', async () => {
    stubOksjonikeskus({ page2Status: 200 })
    const result = await fetchAllListings('ee-oksjonikeskus')
    expect(result.auctions).toHaveLength(2)
    expect(result.complete).toBe(true)
  })

  it('keeps the harvested lots but reports an incomplete run when a later list page fails', async () => {
    stubOksjonikeskus({ page2Status: 500 })
    const result = await fetchAllListings('ee-oksjonikeskus')
    expect(result.auctions).toHaveLength(2)
    expect(result.complete).toBe(false)
  })

  it('reports an incomplete run when a detail page fails', async () => {
    stubOksjonikeskus({ page2Status: 200, failingOkid: '100002' })
    const result = await fetchAllListings('ee-oksjonikeskus')
    expect(result.auctions.map((a) => a.externalId)).toEqual(['100001'])
    expect(result.complete).toBe(false)
  })
  it.each([404, 410])('treats a detail page answering %i as a withdrawn lot, not a failure', async (status) => {
    stubOksjonikeskus({ page2Status: 200, failingOkid: '100002', failingStatus: status })
    const result = await fetchAllListings('ee-oksjonikeskus')
    expect(result.auctions.map((a) => a.externalId)).toEqual(['100001'])
    expect(result.complete).toBe(true)
  })
})
