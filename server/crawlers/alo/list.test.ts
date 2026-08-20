import { describe, expect, it } from 'vitest'
import { ALO_OBLASTI } from './constants'
import { mapItem, parseListPage } from './list'

const SOFIA = ALO_OBLASTI[0]!

// Trimmed live markup (verified 2026-08-19) for one apartment card (VIP tier,
// agency publisher, full field set) and one house card (VIP tier, no
// publisher name — a private seller with no agency logo, verified live to be
// a common case on this otherwise-agency-heavy first page). The third card is
// synthetic, covering the variants the live sample happened not to contain:
// an agency with a name but no uploaded logo, a protocol-relative image host,
// a leva-denominated price and an unparseable Квадратура.
const LIST_HTML = `
<html><body><div id="content_container">
<div onclick="window.location = '/prodajba-tristaen-apartament-levski-v-10303435'" class="listvip-item  noselect mb20" id="adrows_10303435" title="продажба тристаен апартамент Левски В">
  <div <div class="listvip-publisher" data-nosnippet><div class="hidden-xs hidden-sm"><img title="Партньор 2000 ЕООД" class="listvip-logo" src="user_files/p/partnior2000/1760506960_avatar.jpg" /></div><span class="hidden-xs hidden-sm">Партньор 2000 ЕООД</span><br  class="hidden-xs hidden-sm"><span>днешна обява</span></div>
  <div class="listvip-image landscape "><div class="imageblur-listing" style="--bg-src: url(https://www.alo.bg/user_files/p/partnior2000/10303435_139838417_medium.jpg);"></div>
    <a href="/prodajba-tristaen-apartament-levski-v-10303435" title="продажба тристаен апартамент Левски В"><img class="listvip-image-img" loading="lazy" src="user_files/p/partnior2000/10303435_139838417_medium.jpg" alt="продажба тристаен апартамент Левски В"></a><img alt="VIP обява" style="height: 18px;" src="/template/images/icons/vip.svg">
  </div>
  <div class="listvip-params">
    <div class="listvip-item-header">
      <a href="/prodajba-tristaen-apartament-levski-v-10303435" title="продажба тристаен апартамент Левски В"><h3 class="listvip-item-title">продажба тристаен апартамент Левски В</h3></a>
      <div class="listvip-item-address" ><i><img alt="google maps icon" style="width:18px;" src="/template/images/icons/google-maps-color-icon.svg" > Левски В, София</i></div>
    </div>
    <div class="listvip-item-content"><span class="ads-params-multi first_pclass_vip"  title="Цена" ><span class="ads-param-name">Цена</span>: <span class="price_nowrap">210 332 €</span></span>
<span class="ads-params-multi"  title="за кв.м" > <span class="nowrap"style="font-size:13px;"><span class="price_nowrap">1752.77 €/кв.м</span></span></span>
<span class="ads-params-multi"  title="Вид на имота" >Тристаен апартамент в София</span>
<span class="ads-params-multi"  title="Квадратура" >120 кв.м</span>
<span class="ads-params-multi"  title="Вид строителство" >Тухла</span>
<span class="ads-params-multi"  title="Година на строителство" >2027 г.</span>
<span class="ads-params-multi"  title="Номер на етажа" >2 етаж</span>
<span class="ads-params-multi"  title="Етаж" >Непоследен</span>
<span class="ads-params-multi"  title="Степен на завършеност" >В строеж</span>
  <p class="listvip-desc">Инвеститор и строител, без комисионна от клиента, предлага апартаменти..</p>
    </div>
  </div>
</div><div onclick="window.location = '/parvi-etaj-ot-kashta-10490236'" class="listvip-item  noselect mb20" id="adrows_10490236" title="Първи Етаж от къща">
  <div <div class="listvip-publisher" data-nosnippet><br  class="hidden-xs hidden-sm"><span>днешна обява</span></div>
  <div class="listvip-image landscape "><div class="imageblur-listing" style="--bg-src: url(https://www.alo.bg/user_files/v/velevan/10490236_139800145_medium.jpg);"></div>
    <a href="/parvi-etaj-ot-kashta-10490236" title="Първи Етаж от къща"><img class="listvip-image-img" loading="lazy" src="user_files/v/velevan/10490236_139800145_medium.jpg" alt="Първи Етаж от къща"></a>
  </div>
  <div class="listvip-params">
    <div class="listvip-item-header">
      <a href="/parvi-etaj-ot-kashta-10490236"><h3 class="listvip-item-title">Първи Етаж от къща</h3></a>
      <div class="listvip-item-address" ><i><i class="fa fa-map-marker"></i>Банкя, област  София</i></div>
    </div>
    <div class="listvip-item-content"><span class="ads-params-multi first_pclass_vip"  title="Цена" ><span class="ads-param-name">Цена</span>: <span class="price_nowrap">110 000 €</span></span>
<span class="ads-params-multi"  title="Етажност" >Триетажна къща в Банкя</span>
<span class="ads-params-multi"  title="РЗП" >63 кв.м РЗП</span>
  <p class="listvip-desc">СОБСТВЕНИК: Продавам Първи етаж..</p>
    </div>
  </div>
</div><div onclick="window.location = '/prodajba-kashta-plovdiv-10490999'" class="listvip-item  noselect mb20" id="adrows_10490999" title="Продажба къща Пловдив">
  <div <div class="listvip-publisher" data-nosnippet><span class="hidden-xs hidden-sm">Имоти Пловдив ЕООД</span><br  class="hidden-xs hidden-sm"><span>днешна обява</span></div>
  <div class="listvip-image landscape ">
    <a href="/prodajba-kashta-plovdiv-10490999"><img class="listvip-image-img" loading="lazy" src="//cdn.alo.bg/user_files/i/imoti/10490999_1_medium.jpg" alt="Продажба къща Пловдив"></a>
  </div>
  <div class="listvip-params">
    <div class="listvip-item-header">
      <a href="/prodajba-kashta-plovdiv-10490999"><h3 class="listvip-item-title">Продажба къща Пловдив</h3></a>
      <div class="listvip-item-address" ><i>Пловдив</i></div>
    </div>
    <div class="listvip-item-content"><span class="ads-params-multi first_pclass_vip"  title="Цена" ><span class="ads-param-name">Цена</span>: <span class="price_nowrap">410 000 лв.</span></span>
<span class="ads-params-multi"  title="Квадратура" >по договаряне</span>
<span class="ads-params-multi"  title="РЗП" >180 кв.м РЗП</span>
    </div>
  </div>
</div>
</div></body></html>
`

describe('parseListPage', () => {
  it('extracts every card despite the site\'s own malformed "<div <div" publisher markup', () => {
    expect(parseListPage(LIST_HTML)).toHaveLength(3)
  })

  it('parses id, title, address, facts, publisher name and thumbnail for the apartment card', () => {
    const [item] = parseListPage(LIST_HTML)
    expect(item?.externalId).toBe('10303435')
    expect(item?.title).toBe('продажба тристаен апартамент Левски В')
    expect(item?.address).toBe('Левски В, София')
    expect(item?.authority).toBe('Партньор 2000 ЕООД')
    expect(item?.detailUrl).toBe('https://www.alo.bg/prodajba-tristaen-apartament-levski-v-10303435')
    expect(item?.thumbnailUrl).toBe('https://www.alo.bg/user_files/p/partnior2000/10303435_139838417_medium.jpg')
    // The redundant "Цена: " label prefix must not leak into the parsed value.
    expect(item?.facts.get('Цена')).toBe('210 332 €')
    expect(item?.facts.get('Вид на имота')).toBe('Тристаен апартамент в София')
    expect(item?.facts.get('Квадратура')).toBe('120 кв.м')
  })

  it('leaves authority null for a card with no publisher name at all (private seller)', () => {
    const [, item] = parseListPage(LIST_HTML)
    expect(item?.externalId).toBe('10490236')
    expect(item?.authority).toBeNull()
    expect(item?.facts.get('РЗП')).toBe('63 кв.м РЗП')
    expect(item?.facts.get('Вид на имота')).toBeUndefined()
  })

  it('reads the publisher name span when the agency uploaded no logo, ignoring the posting-age span', () => {
    const [, , item] = parseListPage(LIST_HTML)
    expect(item?.authority).toBe('Имоти Пловдив ЕООД')
  })

  it('keeps protocol-relative thumbnail URLs on their own host', () => {
    const [, , item] = parseListPage(LIST_HTML)
    expect(item?.thumbnailUrl).toBe('https://cdn.alo.bg/user_files/i/imoti/10490999_1_medium.jpg')
  })
})

describe('mapItem', () => {
  it('maps a fully populated apartment card', () => {
    const [item] = parseListPage(LIST_HTML)
    const auction = mapItem(item!, SOFIA)

    expect(auction.platform).toBe('bg-alo')
    expect(auction.country).toBe('bg')
    expect(auction.region).toBe('София')
    expect(auction.caseNumber).toBe('')
    expect(auction.authority).toBe('Партньор 2000 ЕООД')
    expect(auction.address).toBe('Левски В, София, Bulgarien')
    expect(auction.marketValueEur).toBe(210332)
    expect(auction.marketValueText).toBe('210.332 €')
    expect(auction.sourceLivingAreaSqm).toBe(120)
    expect(auction.sourceLandAreaSqm).toBeNull()
    expect(auction.sourceRooms).toBe(3)
    expect(auction.auctionDateIso).toBeNull()
    expect(auction.cancelled).toBe(false)
    expect(auction.photoCount).toBe(1)
  })

  it('falls back to the generic authority and reads РЗП as living area for a house card with no room-count field', () => {
    const [, item] = parseListPage(LIST_HTML)
    const auction = mapItem(item!, SOFIA)

    expect(auction.authority).toBe('Частно лице (alo.bg)')
    expect(auction.address).toBe('Банкя, област София, Bulgarien')
    expect(auction.marketValueEur).toBe(110000)
    expect(auction.sourceLivingAreaSqm).toBe(63)
    expect(auction.sourceRooms).toBeNull()
  })

  it('drops a non-euro price rather than booking leva as euros, and falls back to РЗП past an unparseable Квадратура', () => {
    const [, , item] = parseListPage(LIST_HTML)
    const auction = mapItem(item!, SOFIA)

    expect(auction.marketValueEur).toBeNull()
    expect(auction.marketValueText).toBeNull()
    // 'по договаряне' is present but unparseable — must not suppress РЗП.
    expect(auction.sourceLivingAreaSqm).toBe(180)
  })
})

// Trimmed live markup (verified 2026-08-20) of a TOP-tier card, whose facts sit
// in a label/value table instead of the VIP tier's `.ads-params-multi[title]`
// spans. These placements fill a category's whole first page on Plovdiv and
// about half of Sofia's, so the tier is not a rare edge case. The site's own
// HTML comments between the cells (kept here) must not leak into the values.
const LIST_TOP_HTML = `
<html><body><div id="content_container">
<div onclick="window.location='/sobstvenik-prodava-2-staen-apartament-11054526'" class="listtop-item noselect mb20" id="adrows_11054526" title="Собственик продава 2-стаен апартамент">
  <div class="hidden-xs hidden-sm listtop-publisher" data-nosnippet><span>вчера</span></div>
  <div class="listtop-image landscape ">
    <a href="/sobstvenik-prodava-2-staen-apartament-11054526"><img class="listtop-image-img" loading="lazy" src="user_files/a/alexn/11054526_145539091_medium.jpg" alt="x"></a>
  </div>
  <div class="listtop-params">
    <div class="listtop-item-header">
      <a href="/sobstvenik-prodava-2-staen-apartament-11054526"><h3 class="listtop-item-title">Собственик продава 2-стаен апартамент</h3></a>
      <div class="listtop-item-address" ><i>Гоце Делчев, София</i></div>
    </div>
    <div class="listtop-item-params"><div class="ads-params ads-params-table ads-params-table-inline"><div class="ads-params-row"><!--
      --><div class="ads-param-title theme-color1 hidden-mobile  first_pclass">Цена:</div><!--
      --><div class="ads-params-cell  animation-element bounce-up in-view first_pclass"><!--
        --><span class="ads-params-single"><span class="price_nowrap">207 000 €</span></span><!--
      --></div><!--
    --></div> <div class="ads-params-row"><!--
      --><div class="ads-param-title theme-color1 hidden-mobile ">за кв.м:</div><!--
      --><div class="ads-params-cell"><span class="ads-params-single"><span class="price_nowrap">3338.71 €/кв.м</span></span></div><!--
    --></div> <div class="ads-params-row"><!--
      --><div class="ads-param-title theme-color1 hidden-mobile ">Вид на имота:</div><!--
      --><div class="ads-params-cell"><span class="ads-params-single">Двустаен апартамент в София</span></div><!--
    --></div> <div class="ads-params-row"><!--
      --><div class="ads-param-title theme-color1 hidden-mobile ">Квадратура:</div><!--
      --><div class="ads-params-cell"><span class="ads-params-single">62 кв.м</span></div><!--
    --></div> </div></div>
  </div>
</div>
</div></body></html>
`

describe('parseListPage for the TOP tier', () => {
  it('reads the label/value table the VIP `.ads-params-multi` selector does not cover', () => {
    const [item] = parseListPage(LIST_TOP_HTML)

    expect(item?.externalId).toBe('11054526')
    // The label's trailing colon belongs to the markup, not to the field name —
    // it has to be stripped so mapItem's VIP-shaped lookups keep matching.
    expect(item?.facts.get('Цена')).toBe('207 000 €')
    expect(item?.facts.get('Квадратура')).toBe('62 кв.м')
    expect(item?.facts.get('Вид на имота')).toBe('Двустаен апартамент в София')
  })

  it('maps price, living area and room count for a TOP card', () => {
    const auction = mapItem(parseListPage(LIST_TOP_HTML)[0]!, SOFIA)

    expect(auction.marketValueEur).toBe(207000)
    expect(auction.sourceLivingAreaSqm).toBe(62)
    expect(auction.sourceRooms).toBe(2)
    // The rest of the card is template-independent and must keep working.
    expect(auction.address).toBe('Гоце Делчев, София, Bulgarien')
    expect(auction.authority).toBe('Частно лице (alo.bg)')
    expect(auction.thumbnailUrl).toBe('https://www.alo.bg/user_files/a/alexn/11054526_145539091_medium.jpg')
  })
})
