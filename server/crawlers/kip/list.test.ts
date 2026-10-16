import { describe, expect, it } from 'vitest'
import { extractPageCount, mapItem, parseListPage } from './list'
import { applyAreaFacts } from './text'

const LIST_HTML = `
<html><body>
<div class="bgSecondaryLight b-grey hover m-b-30 list-element">
    <a id="objekt_H9067659"></a>
    <div class="col-sm-12 p-0 clearfix">
        <h3 class="h4 m-h-10 m-v-20 fw-400"><a href="/bremen/kaufen/Haus_H9067659">Provisionsfrei RMH Wohnfläche 150qm Grundstück 230qm Kattenesch</a></h3>
    </div>
    <div class="col-md-4 col-sm-12 p-0">
        <a href="/bremen/kaufen/Haus_H9067659">
            <img class="img-responsive lazy m_full" src="//media.wunschgrundstueck.de/img/kip/1x1.png" data-original="//media.wunschgrundstueck.de/bilder/image/resizeandfill/240/180/1594454295">
        </a>
    </div>
    <div class="col-md-8 col-sm-12 p-h-15">
        <div class="col-xs-12"><h4 class="h5 m-b-15 fw-400">28277 Bremen</h4></div>
        <div class="col-xs-12 col-md-6">
            <dl class="m-b-10"><dt title="" class="m-b--5 fw-400 fs-18">150 m&sup2;</dt><dd><small>Wohnfläche</small></dd></dl>
        </div>
        <div class="col-xs-12 col-md-6">
            <dl class="m-b-10"><dt title="" class="m-b--5 fw-400 fs-18">5</dt><dd><small>Zimmer</small></dd></dl>
        </div>
        <div class="col-xs-12 col-md-6">
            <dl class="m-b-10"><dt title="" class="m-b--5 fw-400 fs-18">349.000,00 &#128;</dt><dd><small>Kaufpreis</small></dd></dl>
        </div>
        <div class="col-xs-12 col-md-6">
            <dl class="m-b-10"><dt title="" class="m-b--5 fw-400 fs-18">230,00 m&sup2;</dt><dd><small>Grundstück</small></dd></dl>
        </div>
        <div class="col-xs-12 col-md-6">
            <dl class="m-b-10"><dt title="Einfamilienhaus" class="m-b--5 fw-400 fs-18">EFH</dt><dd><small>Haustyp</small></dd></dl>
        </div>
    </div>
</div>
<div class="bgSecondaryLight b-grey hover m-b-30 list-element">
    <a id="objekt_W7498859"></a>
    <div class="col-sm-12 p-0 clearfix">
        <h3 class="h4 m-h-10 m-v-20 fw-400"><a href="/bremen/kaufen/Wohnung_W7498859">3-Zimmer-Wohnung mit schönem Balkon</a></h3>
    </div>
    <div class="col-md-4 col-sm-12 p-0"></div>
    <div class="col-md-8 col-sm-12 p-h-15">
        <div class="col-xs-12"><h4 class="h5 m-b-15 fw-400">28237 Bremen</h4></div>
        <div class="col-xs-12 col-md-6">
            <dl class="m-b-10"><dt title="" class="m-b--5 fw-400 fs-18">68 m&sup2;</dt><dd><small>Wohnfläche</small></dd></dl>
        </div>
        <div class="col-xs-12 col-md-6">
            <dl class="m-b-10"><dt title="" class="m-b--5 fw-400 fs-18">3</dt><dd><small>Zimmer</small></dd></dl>
        </div>
        <div class="col-xs-12 col-md-6">
            <dl class="m-b-10"><dt title="" class="m-b--5 fw-400 fs-18">119.000,00 &#128;</dt><dd><small>Kaufpreis</small></dd></dl>
        </div>
        <div class="col-xs-12 col-md-6">
            <dl class="m-b-10"><dt title="" class="m-b--5 fw-400 fs-18">Etagenwohnung</dt><dd><small>Typ</small></dd></dl>
        </div>
    </div>
</div>
</body></html>
`

const EMPTY_CATEGORY_HTML = `
<html><body>
<div class="pull-right"><h2 class="h5 fs-10em">aktuell keine Sonstige Immobilien</h2></div>
</body></html>
`

const PAGE_SELECT_HTML = `
<html><body>
<select name="seite_">
    <option value="1" selected="selected">Seite 1</option>
    <option value="2">Seite 2</option>
    <option value="3">Seite 3</option>
    <option value="4">Seite 4</option>
</select>
</body></html>
`

describe('parseListPage', () => {
  it('extracts both objects', () => {
    expect(parseListPage(LIST_HTML)).toHaveLength(2)
  })

  it('parses id, title, address, thumbnail and facts for the first object', () => {
    const [item] = parseListPage(LIST_HTML)
    expect(item?.externalId).toBe('H9067659')
    expect(item?.title).toBe('Provisionsfrei RMH Wohnfläche 150qm Grundstück 230qm Kattenesch')
    expect(item?.postalCity).toBe('28277 Bremen')
    expect(item?.detailUrl).toBe('https://www.kip.net/bremen/kaufen/Haus_H9067659')
    expect(item?.thumbnailUrl).toBe(
      'https://media.wunschgrundstueck.de/bilder/image/resizeandfill/240/180/1594454295',
    )
    expect(item?.facts.get('Wohnfläche')).toBe('150 m²')
    expect(item?.facts.get('Zimmer')).toBe('5')
    expect(item?.facts.get('Kaufpreis')).toBe('349.000,00 €')
    expect(item?.facts.get('Grundstück')).toBe('230,00 m²')
  })

  it('leaves the thumbnail null when the card has no image', () => {
    const [, item] = parseListPage(LIST_HTML)
    expect(item?.externalId).toBe('W7498859')
    expect(item?.thumbnailUrl).toBeNull()
    expect(item?.facts.get('Kaufpreis')).toBe('119.000,00 €')
  })

  it('returns an empty array for a category with zero current listings', () => {
    expect(parseListPage(EMPTY_CATEGORY_HTML)).toEqual([])
  })
})

describe('mapItem + applyAreaFacts', () => {
  it('maps a fully populated item and layers the facts on top', () => {
    const [item] = parseListPage(LIST_HTML)
    const auction = mapItem(item!, 'Bremen')
    applyAreaFacts(auction, item!.facts)

    expect(auction.platform).toBe('kip')
    expect(auction.country).toBe('de')
    expect(auction.region).toBe('Bremen')
    expect(auction.caseNumber).toBe('')
    expect(auction.authority).toBe('immovativ GmbH (KIP)')
    expect(auction.address).toBe('28277 Bremen')
    expect(auction.marketValueEur).toBe(349000)
    expect(auction.marketValueText).toBe('349.000,00 €')
    expect(auction.sourceLivingAreaSqm).toBe(150)
    expect(auction.sourceLandAreaSqm).toBe(230)
    expect(auction.sourceRooms).toBe(5)
    expect(auction.auctionDateIso).toBeNull()
    expect(auction.auctionDateText).toBeNull()
    expect(auction.cancelled).toBe(false)
    expect(auction.attachments).toEqual([])
  })

  it('leaves marketValueEur/-Text null when Kaufpreis is absent from the facts', () => {
    const item = parseListPage(LIST_HTML)[0]!
    item.facts.delete('Kaufpreis')
    const auction = mapItem(item, 'Bremen')
    applyAreaFacts(auction, item.facts)
    expect(auction.marketValueEur).toBeNull()
    expect(auction.marketValueText).toBeNull()
  })
})

describe('extractPageCount', () => {
  it('reads the page count from the "seite_" select', () => {
    expect(extractPageCount(PAGE_SELECT_HTML)).toBe(4)
  })

  it('defaults to 1 when the select is absent (e.g. zero results)', () => {
    expect(extractPageCount(EMPTY_CATEGORY_HTML)).toBe(1)
  })
})
