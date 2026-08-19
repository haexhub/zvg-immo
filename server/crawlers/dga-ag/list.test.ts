import { describe, expect, it } from 'vitest'
import { mapItem, parseListPage } from './list'

const LIST_HTML = `
<html><body>
<div class="tx_goauktion_block" data-jplist-item>
  <span style="display:none;" class="Sachsen"></span>
  <div class="image-block">
    <a href="/immobilie-ersteigern/immobilie-suchen-und-finden/objekt/S26-01-001.html?cHash=abc">
      <img src="/fileadmin/_processed_/a/b/csm_preview_x.jpg">
    </a>
  </div>
  <div class="des-block">
    <div class="auktion-heading">
      <div class="h-col katalogpos">
        <a href="/immobilie-ersteigern/immobilie-suchen-und-finden/objekt/S26-01-001.html?cHash=abc">
          <div class="bgTag event-colors-S"><label>Nr.</label><p class="S26-01 S">S26-01-001</p></div>
        </a>
      </div>
      <div class="h-col verkaufsstatus"><label>Status</label><p class="aktuell">Aktuell</p></div>
    </div>
    <div class="auktion-details">
      <div class="d-col auktion_limit price">
        <label>€ Auktionslimit</label>
        <span style="display:none;" class="auktionLimitAmoutForSorting">125000</span>
        <p>125.000</p>
      </div>
      <div class="d-col objekt">
        <label>Objekt</label>
        <p class="addr-list">
          <a href="/immobilie-ersteigern/immobilie-suchen-und-finden/objekt/S26-01-001.html?cHash=abc">
            Sonniges Reihenhaus<br/>
            Musterstraße 1<br/>
            01067&nbsp;Dresden
          </a>
        </p>
        <div class="ortIco"><a data-toggle="modal" data-lat="51.05" data-lon="13.74"><img class="EFHZFH"></a></div>
      </div>
    </div>
  </div>
</div>
<div class="tx_goauktion_block" data-jplist-item>
  <div class="image-block"></div>
  <div class="des-block">
    <div class="auktion-heading">
      <div class="h-col katalogpos">
        <a href="/immobilie-ersteigern/immobilie-suchen-und-finden/objekt/X26-02-002.html?cHash=def">
          <div class="bgTag event-colors-X"><label>Nr.</label><p class="X26-02 X">X26-02-002</p></div>
        </a>
      </div>
      <div class="h-col verkaufsstatus"><label>Status</label><p class="nachverkauf">Nachverkauf</p></div>
    </div>
    <div class="auktion-details">
      <div class="d-col auktion_limit price">
        <label>€ Auktionslimit</label>
      </div>
      <div class="d-col objekt">
        <label>Objekt</label>
        <p class="addr-list">
          <a href="/immobilie-ersteigern/immobilie-suchen-und-finden/objekt/X26-02-002.html?cHash=def">
            Nebenstraße 2<br/>
            99999&nbsp;Irgendwo
          </a>
        </p>
        <div class="ortIco"><a data-toggle="modal"><img class="GRDBG"></a></div>
      </div>
    </div>
  </div>
</div>
</body></html>
`

describe('parseListPage', () => {
  it('extracts both objects', () => {
    const items = parseListPage(LIST_HTML)
    expect(items).toHaveLength(2)
  })

  it('parses id, house code, region, geo and price for the first object', () => {
    const [item] = parseListPage(LIST_HTML)
    expect(item?.externalId).toBe('S26-01-001')
    expect(item?.houseCode).toBe('s')
    expect(item?.regionCode).toBe('sn')
    expect(item?.lat).toBe(51.05)
    expect(item?.lng).toBe(13.74)
    expect(item?.auktionslimit).toBe(125000)
    expect(item?.auktionslimitText).toBe('125.000 €')
    expect(item?.titleHint).toBe('Sonniges Reihenhaus')
    expect(item?.street).toBe('Musterstraße 1')
    expect(item?.cityLine).toBe('01067 Dresden')
  })

  it('falls back to nulls when region/geo/price/title are absent', () => {
    const [, item] = parseListPage(LIST_HTML)
    expect(item?.externalId).toBe('X26-02-002')
    expect(item?.houseCode).toBe('x')
    expect(item?.regionCode).toBe('')
    expect(item?.lat).toBeNull()
    expect(item?.lng).toBeNull()
    expect(item?.auktionslimit).toBeNull()
    expect(item?.auktionslimitText).toBeNull()
    expect(item?.titleHint).toBeNull()
    expect(item?.street).toBe('Nebenstraße 2')
    expect(item?.cityLine).toBe('99999 Irgendwo')
  })
})

describe('mapItem', () => {
  it('maps a fully populated item', () => {
    const [item] = parseListPage(LIST_HTML)
    const a = mapItem(item!)
    expect(a.platform).toBe('dga-ag')
    expect(a.country).toBe('de')
    expect(a.region).toBe('Sachsen')
    expect(a.authority).toBe('SGA AG')
    expect(a.caseNumber).toBe('')
    expect(a.address).toBe('Musterstraße 1, 01067 Dresden')
    expect(a.marketValueEur).toBe(125000)
    expect(a.startingBid).toBe(125000)
    expect(a.auctionDateIso).toBeNull()
    expect(a.cancelled).toBe(false)
    expect(a.lat).toBe(51.05)
    expect(a.lng).toBe(13.74)
  })

  it('falls back to the generic authority label for an unknown house code', () => {
    const [, item] = parseListPage(LIST_HTML)
    const a = mapItem(item!)
    expect(a.authority).toBe('DGA AG')
    expect(a.region).toBe('')
    expect(a.title).toBeNull()
    expect(a.marketValueEur).toBeNull()
  })
})
