import { describe, expect, it } from 'vitest'
import { ALO_OBLASTI } from './constants'
import { mapItem, parseListPage } from './list'

const SOFIA = ALO_OBLASTI[0]!

// Trimmed live markup (verified 2026-08-19) for one apartment card (VIP tier,
// agency publisher, full field set) and one house card (VIP tier, no
// publisher name — a private seller with no agency logo, verified live to be
// a common case on this otherwise-agency-heavy first page).
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
</div>
</div></body></html>
`

describe('parseListPage', () => {
  it('extracts both cards despite the site\'s own malformed "<div <div" publisher markup', () => {
    expect(parseListPage(LIST_HTML)).toHaveLength(2)
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

  it('leaves authority null for a card with no publisher name (private seller)', () => {
    const [, item] = parseListPage(LIST_HTML)
    expect(item?.externalId).toBe('10490236')
    expect(item?.authority).toBeNull()
    expect(item?.facts.get('РЗП')).toBe('63 кв.м РЗП')
    expect(item?.facts.get('Вид на имота')).toBeUndefined()
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
})
