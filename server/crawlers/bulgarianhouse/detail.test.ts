import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { enrichOne } from './detail'

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } })
}

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'bg-bulgarianhouse',
    country: 'bg',
    region: 'Dobrich',
    externalId: '15924',
    caseNumber: '',
    authority: 'Bulgarian House Ltd',
    title: 'Exclusive Luxury Stone Villa Near the Black Sea',
    address: 'Dobrich',
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: 'https://www.bulgarianhouse.com/property/exclusive-luxury-stone-villa-near-the-black-sea-15924/',
    pdfUrlUpstream: null,
    detailUrlUpstream: 'https://www.bulgarianhouse.com/property/exclusive-luxury-stone-villa-near-the-black-sea-15924/',
    attachments: [],
    description: null,
    photoCount: 1,
    thumbnailUrl: 'https://www.bulgarianhouse.com/photos/tn1_1779120463.jpg',
    ...overrides,
  }
}

const PHOTO_URLS = [
  '/photos/1779120463_a.jpg',
  '/photos/1779120510_b.jpg',
]

function gallery(urls: string[]): string {
  // The gallery markup is duplicated verbatim for a lightbox list and a
  // slider on the live page — reproduced here so the dedupe logic is
  // actually exercised.
  const links = urls.map((u) => `<a class="fancybox" href="${u}"><img src="${u}"></a>`).join('')
  return `<div class="slider">${links}</div><ul class="gallery">${links}</ul>`
}

function detailHtml(opts: { status: 'available' | 'sold' | 'reserved'; extraFeatures?: string }): string {
  return `
<html><body>
<div id="wrapper" itemtype="http://schema.org/Offer" itemscope>
<h1 itemprop="name">Exclusive Luxury Stone Villa Near the Black Sea</h1>
${gallery(PHOTO_URLS)}
<div class="one_third">
  <h2>Property Features</h2>
  <ul class="features">
    <li class="${opts.status}">${opts.status.toUpperCase()}</li>
    <li>Property: <span itemprop="category">Houses</span> for sale in Dobrich</li>
    <li>Location: Dobrich (Dobrich)</li>
    <li>Area : 120 sq. m.</li>
    <li>Garden: 2000 sq. m.</li>
    <li>Bedrooms: 3</li>
    <li>Furnished: Yes</li>
    <li>Ref. No.: <span itemprop="serialNumber">516</span></li>
    ${opts.extraFeatures ?? ''}
  </ul>
  <h2>Price</h3>
  <meta content="EUR" itemprop="priceCurrency" />
  <span class="price" itemprop="price" content="220000">220000 EUR</span> <br />
  <meta content="BGN" itemprop="priceCurrency" />
  <span class="price" itemprop="price" content="220000">440000 BGN</span> <br />
  <h2>Nearest Airport</h3>
  <ul class="features">
    <li class="airport">Varna 50 km approx</li>
  </ul>
</div>
<div itemprop="description">Peaceful countryside home near Dobrich.<br /><br />Move-in ready.</div>
</div>
</body></html>
`
}

describe('enrichOne', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fills location, price, description and deduped photos for an available listing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(detailHtml({ status: 'available' }))))
    const auction = makeAuction()
    await enrichOne(auction)

    expect(auction.cancelled).toBe(false)
    expect(auction.address).toBe('Dobrich')
    expect(auction.region).toBe('Dobrich')
    expect(auction.marketValueEur).toBe(220000)
    expect(auction.marketValueText).toBe('220000 EUR')
    expect(auction.sourceLivingAreaSqm).toBe(120)
    expect(auction.sourceLandAreaSqm).toBe(2000)
    expect(auction.description).toBe('Peaceful countryside home near Dobrich. Move-in ready.')
    expect(auction.photoUrls).toEqual([
      'https://www.bulgarianhouse.com/photos/1779120463_a.jpg',
      'https://www.bulgarianhouse.com/photos/1779120510_b.jpg',
    ])
    expect(auction.photoCount).toBe(2)
  })

  it('marks cancelled=true when the detail page shows the sold badge', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(detailHtml({ status: 'sold' }))))
    const auction = makeAuction()
    await enrichOne(auction)
    expect(auction.cancelled).toBe(true)
  })

  it('splits "Town (Oblast)" into address="Town, Oblast" when they differ', async () => {
    const html = detailHtml({ status: 'available' }).replace('Location: Dobrich (Dobrich)', 'Location: Karnobat (Burgas)')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(html)))
    const auction = makeAuction({ region: 'Burgas', address: 'Burgas' })
    await enrichOne(auction)
    expect(auction.address).toBe('Karnobat, Burgas')
    expect(auction.region).toBe('Burgas')
  })

  it('does not pick up the unrelated "Nearest Airport" .features list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(detailHtml({ status: 'available' }))))
    const auction = makeAuction()
    await enrichOne(auction)
    // Would be non-null (garbage) if propertyFeatures() fell back to a
    // page-wide `.features` selector instead of the heading-scoped one.
    expect(auction.sourceLivingAreaSqm).toBe(120)
  })

  it('keeps a RESERVED listing available, like the card-side badge check does', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(detailHtml({ status: 'reserved' }))))
    const auction = makeAuction({ cancelled: true })
    await enrichOne(auction)
    expect(auction.cancelled).toBe(false)
  })

  it('keeps the card\'s cancelled flag when the detail page states no status at all', async () => {
    // A renamed heading (or any markup change that hides the status item) must
    // not read as "available" and un-cancel what the SOLD card badge flagged.
    const html = detailHtml({ status: 'sold' }).replace('Property Features', 'Features')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(html)))
    const auction = makeAuction({ cancelled: true })
    await enrichOne(auction)
    expect(auction.cancelled).toBe(true)
  })

  it('does nothing when the auction has no detail URL', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const auction = makeAuction({ detailUrl: null, detailUrlUpstream: null })
    await enrichOne(auction)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
