import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAllListings, mapItem, parseListPage } from './list'
import { fetchPageHtml } from './fetch'

vi.mock('./fetch', () => ({ fetchPageHtml: vi.fn() }))

const LIST_HTML = `
<html><body>
<ul class="listing">
  <li class="one_half ">
    <a rel="bookmark" href="/property/massive-seaside-house-with-well-presented-garden-near-karnobat-11905/">
      <span class="imgthumb"><img src="/photos/tn1_1424790560_0_1.jpg" alt="Houses for sale near Burgas - 11905" /></span>
      <h3>Burgas</h3>
      <span class="price">&euro;13000</span>
      <ul class="listing-info">
        <li class="listing-info-beds">3 Bedrooms</li>
        <li class="listing-info-area">108 m<sup>2</sup></li>
        <li class="listing-info-garden">1247 m<sup>2</sup></li>
      </ul>
      <p class="description">Massive seaside house with well presented garden near Karnobat </p>
      <p>&nbsp; </p>
    </a>
  </li>
  <li class="one_half last">
    <a rel="bookmark" href="/property/cozy-one-bedroom-apartment-3-km-from-sunny-beach-sunny-day-5-15365/">
      <span class="imgthumb"></span>
      <h3>Burgas</h3>
      <span class="sold sold-en">SOLD</span>
      <span class="sticker sticker-no-commission">No commission</span>
      <span class="price-line-discount">&euro;39500</span><br />
      <span class="price">&euro;38500</span>
      <ul class="listing-info">
        <li class="listing-info-beds">1 Bedrooms</li>
        <li class="listing-info-area">48 m<sup>2</sup></li>
        <li class="listing-info-garden">0 m<sup>2</sup></li>
      </ul>
      <p class="description">Cozy ONE bedroom apartment 3 km from Sunny beach Sunny Day 5 </p>
    </a>
  </li>
</ul>
</body></html>
`

const EMPTY_PAGE_HTML = `<html><body><ul class="listing"></ul></body></html>`

/** Sold listings drop their figure and publish "€0" instead (verified live). */
const ZERO_PRICE_HTML = `
<html><body>
<ul class="listing">
  <li class="one_half ">
    <a rel="bookmark" href="/property/plot-of-land-with-an-old-house-and-a-barn-for-renovation-konak-14537/">
      <h3>Targovishte</h3>
      <span class="sold sold-en">SOLD</span>
      <span class="price">&euro;0</span>
      <p class="description">Plot of land with an old house and a barn for renovation Konak </p>
    </a>
  </li>
</ul>
</body></html>
`

describe('parseListPage', () => {
  it('extracts both cards', () => {
    expect(parseListPage(LIST_HTML)).toHaveLength(2)
  })

  it('parses id, title, oblast, thumbnail, price and area facts for the available card', () => {
    const [item] = parseListPage(LIST_HTML)
    expect(item?.externalId).toBe('11905')
    expect(item?.title).toBe('Massive seaside house with well presented garden near Karnobat')
    expect(item?.oblast).toBe('Burgas')
    expect(item?.detailUrl).toBe(
      'https://www.bulgarianhouse.com/property/massive-seaside-house-with-well-presented-garden-near-karnobat-11905/',
    )
    expect(item?.thumbnailUrl).toBe('https://www.bulgarianhouse.com/photos/tn1_1424790560_0_1.jpg')
    expect(item?.priceEur).toBe(13000)
    expect(item?.priceText).toBe('€13000')
    expect(item?.livingAreaSqm).toBe(108)
    expect(item?.landAreaSqm).toBe(1247)
    expect(item?.sold).toBe(false)
  })

  it('reads the current (not the struck-through) price and marks a sold card', () => {
    const [, item] = parseListPage(LIST_HTML)
    expect(item?.externalId).toBe('15365')
    expect(item?.priceEur).toBe(38500)
    expect(item?.sold).toBe(true)
  })

  it('treats a "0 m²" garden as no plot rather than a verified zero', () => {
    const [, item] = parseListPage(LIST_HTML)
    expect(item?.landAreaSqm).toBeNull()
  })

  it('returns an empty array for a page with zero cards', () => {
    expect(parseListPage(EMPTY_PAGE_HTML)).toEqual([])
  })

  it('drops the "€0" placeholder instead of passing it on as the price text', () => {
    const [item] = parseListPage(ZERO_PRICE_HTML)
    expect(item?.priceEur).toBeNull()
    expect(item?.priceText).toBeNull()
  })
})

describe('mapItem', () => {
  it('maps a fully populated available item', () => {
    const [item] = parseListPage(LIST_HTML)
    const auction = mapItem(item!)

    expect(auction.platform).toBe('bg-bulgarianhouse')
    expect(auction.country).toBe('bg')
    expect(auction.region).toBe('Burgas')
    expect(auction.address).toBe('Burgas')
    expect(auction.caseNumber).toBe('')
    expect(auction.authority).toBe('Bulgarian House Ltd')
    expect(auction.marketValueEur).toBe(13000)
    expect(auction.marketValueText).toBe('€13000')
    expect(auction.sourceLivingAreaSqm).toBe(108)
    expect(auction.sourceLandAreaSqm).toBe(1247)
    expect(auction.cancelled).toBe(false)
    expect(auction.auctionDateIso).toBeNull()
    expect(auction.attachments).toEqual([])
  })

  it('maps a sold item with cancelled=true', () => {
    const [, item] = parseListPage(LIST_HTML)
    const auction = mapItem(item!)
    expect(auction.cancelled).toBe(true)
    expect(auction.marketValueEur).toBe(38500)
  })
})

describe('fetchAllListings', () => {
  beforeEach(() => {
    vi.mocked(fetchPageHtml).mockReset()
  })

  it('stops at the first empty page after collecting the earlier ones', async () => {
    vi.mocked(fetchPageHtml)
      .mockResolvedValueOnce(LIST_HTML)
      .mockResolvedValueOnce(EMPTY_PAGE_HTML)

    await expect(fetchAllListings()).resolves.toHaveLength(2)
    expect(fetchPageHtml).toHaveBeenCalledTimes(2)
  })

  it('fails instead of reporting an empty catalog when page 1 has no cards', async () => {
    vi.mocked(fetchPageHtml).mockResolvedValue(EMPTY_PAGE_HTML)

    await expect(fetchAllListings()).rejects.toThrow(/page 1 returned zero cards/)
  })
})
