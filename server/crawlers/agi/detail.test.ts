import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { parseDetailHtml, applyDetailInfo } from './detail'

/** Condensed from a real detail page (l2311839, archived 2026-05-19):
 *  swiper gallery with duplicated slide/thumbnail imgs, sidebar attachments,
 *  and the "Dati dei beni" accordion with the .dettagliLotto__item grid. */
function beneBlock(categoria: string, items: Record<string, string>): string {
  const cells = Object.entries(items)
    .map(
      ([label, value]) => `
      <div class="col-md-4 dettagliLotto__item">
        <p>
          <strong>${label}</strong>
          <br />
              <span>${value}</span>
        </p>
        <hr />
      </div>`,
    )
    .join('\n')
  return `
  <div data-pvp-bene-idBene="" data-pvp-bene-area="beneImmobile">
    <p class="titoloBene" data-pvp-bene-categoria="">
        ${categoria}
    </p>
    <div class="dettagliLotto mt-3 pt-3">
      <div class="row">${cells}</div>
    </div>
  </div>`
}

const GALLERY = `
  <div class="swiper swiperFoto swiperScheda">
    <div class="swiper-wrapper">
      <div class="swiper-slide"><img src="/allegato/foto-pv-ei-414-2024-1.jpg/2311839" alt="Fotografia del bene" /></div>
      <div class="swiper-slide"><img src="/allegato/foto-pv-ei-414-2024-2.jpg/2311839" alt="Fotografia del bene" /></div>
    </div>
  </div>
  <div class="swiper swiperFotoThumb">
    <div class="swiper-wrapper">
      <div class="swiper-slide"><img src="/allegato/foto-pv-ei-414-2024-1.jpg/2311839" alt="Fotografia del bene" /></div>
      <div class="swiper-slide"><img data-src="/allegato/foto-pv-ei-414-2024-3.jpg/2311839" alt="Fotografia del bene" /></div>
    </div>
  </div>`

const ATTACHMENTS = `
  <a href="/allegato/perizia-pv-ei-414-2024-c-1.pdf/2311839" class="sidebar-attachment button" target="_blank" title="Perizia">Perizia</a>`

const APARTMENT_HTML = `<html><body>
  ${GALLERY}
  ${ATTACHMENTS}
  ${beneBlock('Appartamento', {
    Indirizzo: 'Via Alberti n. 9/11',
    Piano: '-',
    Vani: '3,00',
    Bagni: '-',
    'Metri quadri': '51,00',
  })}
</body></html>`

const TERRENO_HTML = `<html><body>
  ${beneBlock('Terreno', {
    Piano: '-',
    Vani: '-',
    'Metri quadri': '5.545,00',
  })}
</body></html>`

const COMMERCIALE_HTML = `<html><body>
  ${beneBlock('Immobile commerciale', {
    Vani: '-',
    'Metri quadri': '173,00',
  })}
</body></html>`

describe('parseDetailHtml', () => {
  it('collects deduplicated gallery photo URLs and derives photoCount/thumbnail', () => {
    const info = parseDetailHtml(APARTMENT_HTML)
    expect(info.photoUrls).toEqual([
      'https://www.astegiudiziarie.it/allegato/foto-pv-ei-414-2024-1.jpg/2311839',
      'https://www.astegiudiziarie.it/allegato/foto-pv-ei-414-2024-2.jpg/2311839',
      'https://www.astegiudiziarie.it/allegato/foto-pv-ei-414-2024-3.jpg/2311839',
    ])
    expect(info.photoCount).toBe(3)
    expect(info.thumbnailUrl).toBe(info.photoUrls[0])
  })

  it('parses Vani and Metri quadri as living area for a residential bene', () => {
    const info = parseDetailHtml(APARTMENT_HTML)
    expect(info.livingAreaSqm).toBe(51)
    expect(info.rooms).toBe(3)
    expect(info.landAreaSqm).toBeNull()
    expect(info.unclassifiedAreaSqm).toBeNull()
  })

  it('maps Metri quadri to land area for a Terreno bene, "-" values to null', () => {
    const info = parseDetailHtml(TERRENO_HTML)
    expect(info.landAreaSqm).toBe(5545)
    expect(info.livingAreaSqm).toBeNull()
    expect(info.rooms).toBeNull()
  })

  it('leaves the area unclassified for ambiguous bene categories', () => {
    const info = parseDetailHtml(COMMERCIALE_HTML)
    expect(info.unclassifiedAreaSqm).toBe(173)
    expect(info.livingAreaSqm).toBeNull()
    expect(info.landAreaSqm).toBeNull()
  })

  it('skips bene values when the lot has more than one bene', () => {
    const html = `<html><body>
      ${beneBlock('Appartamento', { 'Metri quadri': '51,00', Vani: '3,00' })}
      ${beneBlock('Terreno', { 'Metri quadri': '900,00' })}
    </body></html>`
    const info = parseDetailHtml(html)
    expect(info.livingAreaSqm).toBeNull()
    expect(info.landAreaSqm).toBeNull()
    expect(info.unclassifiedAreaSqm).toBeNull()
    expect(info.rooms).toBeNull()
  })

  it('still extracts PDF attachments', () => {
    const info = parseDetailHtml(APARTMENT_HTML)
    expect(info.attachments).toHaveLength(1)
    expect(info.attachments[0]?.kind).toBe('appraisal')
    expect(info.pdfUrl).toBe(
      'https://www.astegiudiziarie.it/allegato/perizia-pv-ei-414-2024-c-1.pdf/2311839',
    )
  })
})

function baseAuction(): Auction {
  return {
    platform: 'agi',
    country: 'it',
    region: 'Molise',
    externalId: '1',
    caseNumber: '',
    authority: '',
    title: null,
    address: null,
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
  }
}

describe('applyDetailInfo', () => {
  it('sets photoUrls, source fields and photoCount on the auction', () => {
    const auction = baseAuction()
    applyDetailInfo(auction, parseDetailHtml(APARTMENT_HTML))
    expect(auction.photoUrls).toHaveLength(3)
    expect(auction.photoCount).toBe(3)
    expect(auction.sourceLivingAreaSqm).toBe(51)
    expect(auction.sourceRooms).toBe(3)
    expect(auction.sourceLandAreaSqm).toBeUndefined()
  })

  it('appends an unclassified area as description note, without stacking on re-runs', () => {
    const auction = baseAuction()
    auction.description = 'Locale commerciale al piano terra.'
    const info = parseDetailHtml(COMMERCIALE_HTML)
    applyDetailInfo(auction, info)
    applyDetailInfo(auction, info)
    expect(auction.description).toBe(
      'Locale commerciale al piano terra.\nSuperficie: 173 mq',
    )
    expect(auction.sourceLivingAreaSqm).toBeUndefined()
    expect(auction.sourceLandAreaSqm).toBeUndefined()
  })
})
