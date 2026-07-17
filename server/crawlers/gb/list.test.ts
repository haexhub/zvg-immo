import { describe, expect, it } from 'vitest'
import { parseListPage } from './list'

/** Trimmed markup from https://www.auctionhouse.co.uk/london (verified live
 *  — see server/crawlers/gb/constants.ts). Includes one online-auction lot
 *  (redirects to online.auctionhouse.co.uk) and one own-site lot. */
const LIST_FIXTURE = `
<title>Auction House London | Property Auctioneers in London</title>
<div class="row row-search-results-grid">
<div class="col-sm-12 col-md-8 col-lg-6 text-center lot-search-result">
  <a href="https://online.auctionhouse.co.uk/lot/redirect/356054" class="home-lot-wrapper-link" title="View property details">
    <div class="lot-search-wrapper grid-item rounded-lg overflow-hidden">
      <div class="image-wrapper position-relative">
        <img src="https://cdn.eigpropertyauctions.co.uk/ams/images/96/auction/0/2770097_web_medium" class="lot-image" loading="lazy" alt="Property for Auction in London" />
        <div class="image-sticker fw-semibold lotbg-online">Lot -</div>
      </div>
      <div Class="fw-semibold lotbg-online text-white grid-view-guide">*Guide | £5,000 - £15,000 <small>(plus fees)</small></div>
      <div class="summary-info-wrapper">
        <p class="fw-bold blue-text">3 Bed Apartment</p>
        <p class="fw-medium blue-text grid-address">Apartment 34 Sledmere Close, Peterlee, County Durham, SR8 5JN</p>
      </div>
    </div>
  </a>
</div>
<div class="col-sm-12 col-md-8 col-lg-6 text-center lot-search-result">
  <a href="/london/auction/lot/150748" class="home-lot-wrapper-link" title="View property details">
    <div class="lot-search-wrapper grid-item rounded-lg overflow-hidden">
      <div class="image-wrapper position-relative">
        <img src="/lot-image/906416" class="lot-image" loading="lazy" alt="Property for Auction in London" />
        <div class="image-sticker fw-semibold lotbg-residential">Lot 1</div>
      </div>
      <div Class="fw-semibold lotbg-residential text-white grid-view-guide">*Guide | £475,000+ <small>(plus fees)</small></div>
      <div class="summary-info-wrapper">
        <p class="fw-bold blue-text">4 Bed Semi-Detached House</p>
        <p class="fw-medium blue-text grid-address">31 Lansdowne Road, Stanmore, Middlesex, HA7 2RZ</p>
      </div>
    </div>
  </a>
</div>
</div>`

describe('parseListPage', () => {
  it('parses the online-auction lot card (redirect link, absolute CDN thumbnail)', () => {
    const [item] = parseListPage(LIST_FIXTURE)
    expect(item?.href).toBe('https://online.auctionhouse.co.uk/lot/redirect/356054')
    expect(item?.adresse).toBe('Apartment 34 Sledmere Close, Peterlee, County Durham, SR8 5JN')
    expect(item?.objekt).toBe('3 Bed Apartment')
    expect(item?.priceEur).toBe(5000)
    expect(item?.priceText).toContain('£5,000 - £15,000')
    expect(item?.thumbnailUrl).toBe('https://cdn.eigpropertyauctions.co.uk/ams/images/96/auction/0/2770097_web_medium')
    expect(item?.branchName).toBe('Auction House London')
  })

  it('parses the own-site lot card (relative href + relative thumbnail)', () => {
    const items = parseListPage(LIST_FIXTURE)
    const item = items[1]
    expect(item?.href).toBe('/london/auction/lot/150748')
    expect(item?.adresse).toBe('31 Lansdowne Road, Stanmore, Middlesex, HA7 2RZ')
    expect(item?.objekt).toBe('4 Bed Semi-Detached House')
    expect(item?.priceEur).toBe(475_000)
    expect(item?.thumbnailUrl).toBe('https://www.auctionhouse.co.uk/lot-image/906416')
  })
})
