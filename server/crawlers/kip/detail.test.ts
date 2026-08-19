import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { enrichOne } from './detail'

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } })
}

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'kip',
    country: 'de',
    region: 'Bremen',
    externalId: 'H9067659',
    caseNumber: '',
    authority: 'immovativ GmbH (KIP)',
    title: 'Provisionsfrei RMH Wohnfläche 150qm Grundstück 230qm Kattenesch',
    address: '28277 Bremen',
    marketValueEur: 349000,
    marketValueText: '349.000,00 €',
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: 'https://www.kip.net/bremen/kaufen/Haus_H9067659',
    pdfUrlUpstream: null,
    detailUrlUpstream: 'https://www.kip.net/bremen/kaufen/Haus_H9067659',
    attachments: [],
    description: null,
    photoCount: 1,
    thumbnailUrl: 'https://media.wunschgrundstueck.de/bilder/image/resizeandfill/240/180/1594454295',
    ...overrides,
  }
}

function exposeBox(heading: string, contentHtml: string): string {
  return `
    <div class="exposeInfoContainer">
      <div class="exposeInfoBox">
        <div class="exposeInfoBoxHeader"><h2>${heading}</h2></div>
        <div>${contentHtml}</div>
      </div>
    </div>
  `
}

function factsBox(): string {
  return `
    <div class="exposeInfoBox">
      <div class="exposeInfoBoxRow"><div class="row"><div class="col-xs-6 exposeInfoBoxKey">Kaufpreis</div><div class="col-xs-6 exposeInfoBoxValue">349.000 €</div></div></div>
      <div class="exposeInfoBoxRow"><div class="row"><div class="col-xs-6 exposeInfoBoxKey">Wohnfläche (ca.)</div><div class="col-xs-6 exposeInfoBoxValue">150,00 m²</div></div></div>
      <div class="exposeInfoBoxRow"><div class="row"><div class="col-xs-6 exposeInfoBoxKey">Zimmer</div><div class="col-xs-6 exposeInfoBoxValue">5</div></div></div>
      <div class="exposeInfoBoxRow"><div class="row"><div class="col-xs-6 exposeInfoBoxKey">Grundstück</div><div class="col-xs-6 exposeInfoBoxValue">230,00 m²</div></div></div>
    </div>
  `
}

function photoSlider(id: string, urls: string[]): string {
  return `<div id="${id}">${urls.map((u) => `<div><img data-u="image" src="${u}"></div>`).join('')}</div>`
}

const PHOTO_URLS = [
  '//media.wunschgrundstueck.de/bilder/image/full/1/1/1594454295',
  '//media.wunschgrundstueck.de/bilder/image/full/1/1/1594454297',
]

const DETAIL_HTML_DISCLOSED_ADDRESS = `
<html><head><meta property="og:title" content="Einfamilienhaus in 28205 Bremen"></head>
<body>
${factsBox()}
${photoSlider('exposeSliderSm', PHOTO_URLS)}
${photoSlider('exposeSliderMd', PHOTO_URLS)}
${exposeBox('Objektadresse', 'Liebensteiner Straße 2 <br/> 28205 Bremen')}
${exposeBox('Objektbeschreibung', 'Familienfreundliches Reihenmittelhaus mit 5 Zimmern.<br/>Glasfaser-Internet.')}
${exposeBox(
  'Anbieter dieses Objekts',
  '<p><strong><a href="/anbieter/ohne-maklernet-183285">ohne-makler.net – eine Marke der OhneMakler GmbH</a></strong></p>',
)}
</body></html>
`

const DETAIL_HTML_UNDISCLOSED_ADDRESS = `
<html><head></head>
<body>
${exposeBox(
  'Objektadresse',
  'Die genaue Adresse des Objekts ist vom Anbieter nicht freigegeben. In der Karte ist daher die ungefähre Lage der Immobilie dargestellt.',
)}
</body></html>
`

describe('enrichOne', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fills authority, description, facts, address override and deduped photos', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(DETAIL_HTML_DISCLOSED_ADDRESS)))
    const auction = makeAuction()
    await enrichOne(auction)

    expect(auction.authority).toBe('ohne-makler.net – eine Marke der OhneMakler GmbH')
    expect(auction.address).toBe('Liebensteiner Straße 2, 28205 Bremen')
    expect(auction.description).toBe('Familienfreundliches Reihenmittelhaus mit 5 Zimmern. Glasfaser-Internet.')
    expect(auction.marketValueEur).toBe(349000)
    expect(auction.sourceLivingAreaSqm).toBe(150)
    expect(auction.sourceLandAreaSqm).toBe(230)
    expect(auction.sourceRooms).toBe(5)
    expect(auction.photoUrls).toEqual([
      'https://media.wunschgrundstueck.de/bilder/image/full/1/1/1594454295',
      'https://media.wunschgrundstueck.de/bilder/image/full/1/1/1594454297',
    ])
    expect(auction.photoCount).toBe(2)
  })

  it('keeps the postal-code-only address and existing authority when the exact address is undisclosed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(DETAIL_HTML_UNDISCLOSED_ADDRESS)))
    const auction = makeAuction()
    await enrichOne(auction)

    expect(auction.address).toBe('28277 Bremen')
    expect(auction.authority).toBe('immovativ GmbH (KIP)')
    expect(auction.description).toBeNull()
    expect(auction.photoCount).toBe(1)
    expect(auction.thumbnailUrl).toBe(
      'https://media.wunschgrundstueck.de/bilder/image/resizeandfill/240/180/1594454295',
    )
  })

  it('does nothing when the auction has no detail URL', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const auction = makeAuction({ detailUrl: null, detailUrlUpstream: null })
    await enrichOne(auction)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
