import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { parseDetailPage, enrichOne } from './detail'

/** Trimmed /izsole/<uuid> markup (verified live against two auctions). */
const DETAIL_FIXTURE = `
<div class="gallery-indicators">
  <img class="gallery-indicator-thumb" src="https://izsoles.ta.gov.lv/gallery-thumbnail/attachments/13304c32-5eb6-4cc5-9906-8ebbfa616ec2/17c06668-4a03-4577-ab8f-42a8c7aef9e8/a.jpg">
</div>
<div class="item">
  <img class="photo" src="https://izsoles.ta.gov.lv/attachments/13304c32-5eb6-4cc5-9906-8ebbfa616ec2/17c06668-4a03-4577-ab8f-42a8c7aef9e8/a.jpg">
  <img class="photo" src="https://izsoles.ta.gov.lv/attachments/13304c32-5eb6-4cc5-9906-8ebbfa616ec2/2b0a22e6-0458-48e0-b67c-a3fef5c7883d/b.jpg">
  <img class="photo" src="https://izsoles.ta.gov.lv/attachments/13304c32-5eb6-4cc5-9906-8ebbfa616ec2/17c06668-4a03-4577-ab8f-42a8c7aef9e8/a.jpg">
</div>
<div class="object-info">
  <h4 class="object-title">Augusta Dombrovska iela 9B - 1A, Rīga</h4>
  <p class="object-data">Kadastra numurs :
    <a target="_blank" href="https://www.zemesgramata.lv/...">0100 916 4396</a>
    <br/>Domājamās daļas no īpašuma: 1/1
  <p class="announcement-coordinates">
    <i class="auction-map" data-lat="57.028469" data-long="24.113494"></i>
  </p>
  <div class="valuation-file text-center">
    <a href="https://izsoles.ta.gov.lv/attachments/13304c32-5eb6-4cc5-9906-8ebbfa616ec2/69aff3d6-1933-45b5-ab39-5b454bc56f2a/riga, augusta dombrovska iela 9b-1a bez pielikumiem.pdf">Īpašuma novērtējums</a>
  </div>
</div>
<div class="justify auction-main-text"><p>Rīgas apgabaltiesas ...</p></div>`

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'lv-eizsoles',
    country: 'lv',
    region: '',
    zvgId: '13304c32-5eb6-4cc5-9906-8ebbfa616ec2',
    aktenzeichen: '',
    amtsgericht: 'Dana Krūmiņa',
    objekt: null,
    adresse: 'Augusta Dombrovska iela 9B - 1A, Rīga',
    verkehrswertEur: 2500,
    verkehrswertText: '€ 2 500.00',
    terminIso: '2026-07-17T13:00:00',
    terminText: '17.07.2026, 13:00 Uhr',
    aufgehoben: false,
    letzteAktualisierungIso: null,
    pdfUrl: null,
    detailUrl: 'https://izsoles.ta.gov.lv/izsole/13304c32-5eb6-4cc5-9906-8ebbfa616ec2',
    pdfUrlUpstream: null,
    detailUrlUpstream: 'https://izsoles.ta.gov.lv/izsole/13304c32-5eb6-4cc5-9906-8ebbfa616ec2',
    attachments: [],
    beschreibung: 'Sākumcena: € 1 875.00\n\nRīgas apgabaltiesas iecirkņa Nr.47 ...',
    fotoCount: 1,
    thumbnailUrl: 'https://izsoles.ta.gov.lv/gallery-thumbnail/attachments/x/y/a.jpg',
    ...overrides,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('parseDetailPage', () => {
  it('collects deduped full-size photos, skipping gallery thumbnails', () => {
    const d = parseDetailPage(DETAIL_FIXTURE)
    expect(d.photoUrls).toEqual([
      'https://izsoles.ta.gov.lv/attachments/13304c32-5eb6-4cc5-9906-8ebbfa616ec2/17c06668-4a03-4577-ab8f-42a8c7aef9e8/a.jpg',
      'https://izsoles.ta.gov.lv/attachments/13304c32-5eb6-4cc5-9906-8ebbfa616ec2/2b0a22e6-0458-48e0-b67c-a3fef5c7883d/b.jpg',
    ])
  })

  it('extracts the valuation PDF with an url-encoded, fetchable href', () => {
    const d = parseDetailPage(DETAIL_FIXTURE)
    expect(d.gutachten).toEqual({
      url: 'https://izsoles.ta.gov.lv/attachments/13304c32-5eb6-4cc5-9906-8ebbfa616ec2/69aff3d6-1933-45b5-ab39-5b454bc56f2a/riga,%20augusta%20dombrovska%20iela%209b-1a%20bez%20pielikumiem.pdf',
      fileId: '69aff3d6-1933-45b5-ab39-5b454bc56f2a',
      filename: 'riga, augusta dombrovska iela 9b-1a bez pielikumiem.pdf',
    })
  })

  it('extracts cadastre number, ownership share and coordinates', () => {
    const d = parseDetailPage(DETAIL_FIXTURE)
    expect(d.kadastraNumurs).toBe('0100 916 4396')
    expect(d.domajamasDalas).toBe('1/1')
    expect(d.lat).toBe(57.028469)
    expect(d.lng).toBe(24.113494)
    expect(d.hasContent).toBe(true)
  })

  it('reports missing auction content', () => {
    const d = parseDetailPage('<html><body><div class="search-form"></div></body></html>')
    expect(d.hasContent).toBe(false)
  })
})

describe('enrichOne', () => {
  it('appends labelled object data to the existing notice text and fills gallery + gutachten', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(DETAIL_FIXTURE)))
    const a = makeAuction()
    await enrichOne(a)
    expect(a.beschreibung).toContain('Sākumcena: € 1 875.00')
    expect(a.beschreibung).toContain('Kadastra numurs: 0100 916 4396')
    expect(a.beschreibung).toContain('Domājamās daļas no īpašuma: 1/1')
    expect(a.photoUrls).toHaveLength(2)
    expect(a.fotoCount).toBe(2)
    expect(a.attachments).toHaveLength(1)
    expect(a.attachments[0]).toMatchObject({ kind: 'gutachten', label: 'Īpašuma novērtējums' })
    expect(a.lat).toBe(57.028469)
    expect(a.lng).toBe(24.113494)
  })

  it('throws when the response is not a detail page (invalid session/redirect)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html><body>meklēšana</body></html>')))
    await expect(enrichOne(makeAuction())).rejects.toThrow('unexpected page')
  })

  it('throws on upstream errors so the enrich task retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })))
    await expect(enrichOne(makeAuction())).rejects.toThrow('502')
  })
})
