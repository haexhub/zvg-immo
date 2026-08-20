import { describe, expect, it } from 'vitest'
import { mapItem, parseListPage } from './list'

const LIST_HTML = `
<html><body>
<div class="item__group">
    <div class="col col--grow">
        <div class="header">
            <div class="date">Публикувано на 19 август 2026 г. в 17:04 часа</div>
            <div class="title">Двустаен апартамент</div>
            <div class="category">55.74 кв.м</div>
        </div>
        <div class="content content--price">
            <div class="price">92&nbsp;800.00&nbsp;EUR</div>
            <div class="note">Начална цена</div>
        </div>
    </div>
    <div class="col col--info">
        <div class="label__group">
            <div class="label">НАСЕЛЕНО МЯСТО</div>
            <div class="info">гр. Нови Искър</div>
        </div>
        <div class="label__group label__group--double">
            <div class="label">Адрес</div>
            <div class="info">район Нови Искър, кв. Курило, ул. Кременица № 24</div>
        </div>
    </div>
    <div class="col col--info col--horizontal">
        <div class="label__group label__group--horizontal">
            <div class="label">ОКРЪЖЕН СЪД</div>
            <div class="info">София град</div>
        </div>
        <div class="label__group label__group--horizontal">
            <div class="label">ЧАСТЕН СЪДЕБЕН ИЗПЪЛНИТЕЛ</div>
            <div class="info">Ренета Милчева Василева</div>
        </div>
        <div class="label__group label__group--horizontal">
            <div class="label">СРОК</div>
            <div class="info">от 28.08.2026 до 28.09.2026</div>
        </div>
        <div class="label__group label__group--horizontal">
            <div class="label">ОБЯВЯВАНЕ НА</div>
            <div class="info">29.09.2026 09:00</div>
        </div>
    </div>
    <div class="col col--image">
        <a href="/properties/91381">
            <img src="/upload/91381/455825/20260804_125953.jpg?w=270&amp;h=270" />
        </a>
    </div>
</div>
<div class="item__group">
    <div class="col col--grow">
        <div class="header">
            <div class="date">Публикувано на 19 август 2026 г. в 15:48 часа</div>
            <div class="title">Земеделска земя</div>
            <div class="category">52 558.00 кв.м</div>
        </div>
        <div class="content content--price">
            <div class="price">92&nbsp;480.00&nbsp;EUR</div>
            <div class="note">Начална цена</div>
        </div>
    </div>
    <div class="col col--info">
        <div class="label__group">
            <div class="label">НАСЕЛЕНО МЯСТО</div>
            <div class="info">с. Бранище</div>
        </div>
    </div>
    <div class="col col--info col--horizontal">
        <div class="label__group label__group--horizontal">
            <div class="label">ОКРЪЖЕН СЪД</div>
            <div class="info">Добрич</div>
        </div>
        <div class="label__group label__group--horizontal">
            <div class="label">ЧАСТЕН СЪДЕБЕН ИЗПЪЛНИТЕЛ</div>
            <div class="info">Николай Петров Ников</div>
        </div>
        <div class="label__group label__group--horizontal">
            <div class="label">СРОК</div>
            <div class="info">от 27.07.2026 до 27.08.2026</div>
        </div>
        <div class="label__group label__group--horizontal">
            <div class="label">ОБЯВЯВАНЕ НА</div>
            <div class="info">28.08.2026 09:00</div>
        </div>
    </div>
    <div class="col col--image">
        <a href="/properties/91370">
            <img src="/assets/images/photo-placeholder.png?w=270&amp;h=270" />
        </a>
    </div>
</div>
</body></html>
`

describe('parseListPage', () => {
  it('extracts both cards', () => {
    expect(parseListPage(LIST_HTML)).toHaveLength(2)
  })

  it('parses id, title, area, price, address facts and thumbnail for the first card', () => {
    const [item] = parseListPage(LIST_HTML)
    expect(item?.externalId).toBe('91381')
    expect(item?.title).toBe('Двустаен апартамент')
    expect(item?.areaText).toBe('55.74 кв.м')
    expect(item?.priceText).toBe('92\u0020800.00\u0020EUR')
    expect(item?.settlement).toBe('гр. Нови Искър')
    expect(item?.street).toBe('район Нови Искър, кв. Курило, ул. Кременица № 24')
    expect(item?.courtDistrict).toBe('София град')
    expect(item?.authority).toBe('Ренета Милчева Василева')
    expect(item?.announcedAtText).toBe('29.09.2026 09:00')
    expect(item?.thumbnailUrl).toBe('https://sales.bcpea.org/upload/91381/455825/20260804_125953.jpg?w=270&h=270')
    expect(item?.detailUrl).toBe('https://sales.bcpea.org/properties/91381')
  })

  it('leaves street/thumbnail null when the card has no street line or only a placeholder image', () => {
    const [, item] = parseListPage(LIST_HTML)
    expect(item?.externalId).toBe('91370')
    expect(item?.street).toBeNull()
    expect(item?.thumbnailUrl).toBeNull()
  })
})

describe('mapItem', () => {
  it('maps a fully populated apartment card', () => {
    const [item] = parseListPage(LIST_HTML)
    const auction = mapItem(item!, 'bg-bcpea')

    expect(auction.platform).toBe('bg-bcpea')
    expect(auction.country).toBe('bg')
    expect(auction.region).toBe('София град')
    expect(auction.caseNumber).toBe('')
    expect(auction.authority).toBe('Ренета Милчева Василева')
    expect(auction.address).toBe('район Нови Искър, кв. Курило, ул. Кременица № 24, гр. Нови Искър, Bulgarien')
    expect(auction.marketValueEur).toBe(92800)
    expect(auction.marketValueText).toBe('92.800 €')
    expect(auction.startingBid).toBe(92800)
    expect(auction.sourceLivingAreaSqm).toBe(55.74)
    expect(auction.sourceLandAreaSqm).toBeNull()
    expect(auction.sourceRooms).toBe(2)
    expect(auction.auctionDateIso).toBe('2026-09-29T09:00:00')
    expect(auction.auctionDateText).toBe('29.09.2026, 09:00 Uhr')
    expect(auction.cancelled).toBe(false)
    expect(auction.photoCount).toBe(1)
  })

  it('classifies a land-titled card into sourceLandAreaSqm instead of living area', () => {
    const [, item] = parseListPage(LIST_HTML)
    const auction = mapItem(item!, 'bg-bcpea')

    expect(auction.sourceLivingAreaSqm).toBeNull()
    expect(auction.sourceLandAreaSqm).toBe(52558)
    expect(auction.sourceRooms).toBeNull()
    expect(auction.address).toBe('с. Бранище, Bulgarien')
    expect(auction.photoCount).toBe(0)
    expect(auction.thumbnailUrl).toBeNull()
  })
})
