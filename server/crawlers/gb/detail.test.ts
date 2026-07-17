import { describe, expect, it } from 'vitest'
import { parseOwnDetail, parseOnlineDetail } from './detail'

/** Trimmed markup from a www.auctionhouse.co.uk/<region>/auction/lot/<id>
 *  page (verified live — traditional room/livestream auction template). */
const OWN_FIXTURE = `
<p class="fw-bold auction-info-header">Auction Date</p>
<p>Wed 29/07/2026</p>
<p class="fw-bold auction-info-header">Auction Time</p>
<p>09:30</p>
<div class="lot-details">
  <div class="preline">
    <p class="fw-bold auction-info-header">A Vacant Four Bedroom Semi Detached House</p>
    <p>The property comprises a four bedroom semi detached house in shell condition.</p>
    <p class="fw-bold auction-info-header">Tenure</p>
    <p>Freehold</p>
    <p class="fw-bold auction-info-header">Location</p>
    <p>The property is situated on a residential road close to local shops and amenities.</p>
    <div class="mb-20 p-2 bg-white rounded-lg overflow-hidden">
      <p class="fw-bold auction-info-header">Important Notice to Prospective Buyers:</p>
      <p>We draw your attention to the Special Conditions of Sale within the Legal Pack.</p>
    </div>
  </div>
  <div id="carousel-lot-images" class="carousel slide mb-10">
    <div class="carousel-inner">
      <div class="item img-thumbnail-wrapper active"><img src="/lot-image/906416?w=670" alt="Lot Image" /></div>
      <div class="item img-thumbnail-wrapper"><img src="/lot-image/909733?w=670" alt="Lot Image" /></div>
    </div>
    <div class="row carousel-thumbs">
      <div class="col-xs-6 col-md-4"><a><img src="/lot-image/906416" /></a></div>
      <div class="col-xs-6 col-md-4"><a><img src="/lot-image/909733" /></a></div>
    </div>
  </div>
</div>`

/** Trimmed markup from an online.auctionhouse.co.uk/lot/details/<guid> page
 *  (verified live — online-bidding template). */
const ONLINE_FIXTURE = `
<meta name="description" content="Property for sale online in Peterlee closing on 28/07/2026 with a Guide Price of £5,000-£15,000. - Online Auctions"/>
<ul class="lot-highlights"><li>For Sale By Unconditional Online Auction</li><li>Guide Price* : &#163;5,000-&#163;15,000</li><li>Bidding Opens 27/07/2026 13:00</li></ul>
<h4>A Vacant Ground Floor Three Room Flat</h4>
<h4>Location</h4>
<p><p>The property is situated on a residential road close to local shops and amenities.
</p>
</p>
<h4>Description</h4>
<p><p>The property comprises a ground floor three room flat situated within a purpose built building.
</p>
</p>
<h4>Tenure</h4>
<p><p>Leasehold.
</p>
</p>
<div class="row no-margin lot-info-panel border-0 rounded-10">
  <h4 class="mt-0">Important Notice to Prospective Buyers</h4>
  <p>We draw your attention to the Special Conditions of Sale within the Legal Pack.</p>
</div>
<h4>Administration Charge</h4>
<p><p>£3,900 incl VAT
</p>
</p>
<div id="carousel-lot-images" class="carousel carousel-disabled">
  <div class="carousel-inner">
    <div class="item active"><img src="https://cdn.eigpropertyauctions.co.uk/ams/images/96/auction/0/2770097_web_medium" data-src="https://cdn.eigpropertyauctions.co.uk/ams/images/96/auction/0/2770097_web_medium?v=1" alt="Lot Image" /></div>
    <div class="item"><img src="https://cdn.eigpropertyauctions.co.uk/ams/images/96/auction/0/2770098_web_medium" alt="Lot Image" /></div>
  </div>
</div>
<iframe id="gMap" src="" data-src="https://www.google.com/maps/embed/v1/place?q=54.766552,-1.340293&amp;key=AIzaSyDUMMYKEY0000000000000000000"></iframe>`

describe('parseOwnDetail', () => {
  it('extracts date/time, the description (excluding the boilerplate notice), and the gallery only', () => {
    const d = parseOwnDetail(OWN_FIXTURE)
    expect(d.terminIso).toBe('2026-07-29T09:30:00')
    expect(d.terminText).toBe('Wed 29/07/2026 09:30')
    expect(d.beschreibung).toContain('A Vacant Four Bedroom Semi Detached House')
    expect(d.beschreibung).toContain('Tenure\nFreehold')
    expect(d.beschreibung).not.toContain('Special Conditions of Sale')
    expect(d.photoUrls).toEqual([
      'https://www.auctionhouse.co.uk/lot-image/906416?w=670',
      'https://www.auctionhouse.co.uk/lot-image/909733?w=670',
    ])
    expect(d.lat).toBeNull()
    expect(d.lng).toBeNull()
  })
})

describe('parseOnlineDetail', () => {
  it('extracts the closing date, description sections up to the boilerplate notice, gallery and lat/lng', () => {
    const d = parseOnlineDetail(ONLINE_FIXTURE)
    expect(d.terminIso).toBe('2026-07-28')
    expect(d.terminText).toContain('Bidding Opens 27/07/2026 13:00')
    expect(d.terminText).toContain('Closes 28/07/2026')
    expect(d.beschreibung).toContain('Location\nThe property is situated')
    expect(d.beschreibung).toContain('Description\nThe property comprises')
    expect(d.beschreibung).not.toContain('Administration Charge')
    expect(d.beschreibung).not.toContain('Special Conditions of Sale')
    expect(d.photoUrls).toEqual([
      'https://cdn.eigpropertyauctions.co.uk/ams/images/96/auction/0/2770097_web_medium',
      'https://cdn.eigpropertyauctions.co.uk/ams/images/96/auction/0/2770098_web_medium',
    ])
    expect(d.lat).toBeCloseTo(54.766552)
    expect(d.lng).toBeCloseTo(-1.340293)
  })
})
