import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { enrichOne } from './detail'

// Trimmed live markup (verified 2026-08-19). The "Подобни обяви" (similar
// ads) block on this site is only a handful of internal search-query links,
// not reused listing-card markup — unlike sales.bcpea.org's detail page,
// there is no card-markup trap here to guard against.
const DETAIL_HTML = `
<html><body>
<div id="rkl-imgs"><div id="images-wrapper">
  <a id="main_image_flex" class="landscape fancyimages" href="user_files/p/partnior2000/10303435_139838417_big.jpg" data-fancybox="group" data-type="image">
    <img id="main_image_img" src="user_files/p/partnior2000/10303435_139838417_big.jpg">
  </a>
  <div id="images">
    <a class="fancyimages" href="user_files/p/partnior2000/10303435_138471283_big.jpg" data-fancybox="group" data-type="image"><div class="anotherimage"><img src="user_files/p/partnior2000/10303435_138471283_medium.jpg"></div></a>
    <a id="gallerygoogle" class="fancyimages" data-fancybox="group" data-type="ajax" data-src="/?ajax=gallerygoogle" href="javascript:;"></a>
  </div>
</div></div>
<div class="ads-params-row">
  <div class="ads-param-title ads-params-cell theme-color1">Карта</div>
  <div class="ads-params-cell ads-params-price">
    <a target="_blank" rel="nofollow" href="https://maps.google.com/?q=42.70782814288973,23.377624846945093&ll=42.70782814288973,23.377624846945093&z=18&t=m">Виж на картата</a>
  </div>
</div>
<div class="more-info-wrapper"><div class="more-info">
  <p class="word-break-all highlightable">Инвеститор и строител, без комисионна от клиента, предлага апартаменти в новостроящи се две жилищни сгради. <br />Апартамент със застроена площ от 93.87 кв.м.</p>
</div></div>
<div class="ad_searches_links obqva-block">
  <div class="link_title">Подобни обяви</div>
  <div class="links"><a class="ad_searches_link" href="https://www.alo.bg/searchq/?q=x">продажба на апартаменти софия</a></div>
</div>
</body></html>
`

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'bg-alo',
    country: 'bg',
    region: 'София',
    externalId: '10303435',
    caseNumber: '',
    authority: 'Партньор 2000 ЕООД',
    title: 'продажба тристаен апартамент Левски В',
    address: 'Левски В, София, Bulgarien',
    marketValueEur: 210332,
    marketValueText: '210.332 €',
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: 'https://www.alo.bg/prodajba-tristaen-apartament-levski-v-10303435',
    pdfUrlUpstream: null,
    detailUrlUpstream: 'https://www.alo.bg/prodajba-tristaen-apartament-levski-v-10303435',
    attachments: [],
    description: null,
    photoCount: 1,
    thumbnailUrl: 'https://www.alo.bg/user_files/p/partnior2000/10303435_139838417_medium.jpg',
    ...overrides,
  }
}

beforeEach(() => vi.stubGlobal('useRuntimeConfig', () => ({})))
afterEach(() => vi.unstubAllGlobals())

describe('enrichOne', () => {
  it('extracts description, coordinates and the full-res gallery, excluding the ajax gallerygoogle placeholder', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(DETAIL_HTML)))
    const a = makeAuction()
    await enrichOne(a)

    expect(a.description).toBe(
      'Инвеститор и строител, без комисионна от клиента, предлага апартаменти в новостроящи се две жилищни сгради.\nАпартамент със застроена площ от 93.87 кв.м.',
    )
    expect(a.lat).toBe(42.70782814288973)
    expect(a.lng).toBe(23.377624846945093)
    expect(a.photoUrls).toEqual([
      'https://www.alo.bg/user_files/p/partnior2000/10303435_139838417_big.jpg',
      'https://www.alo.bg/user_files/p/partnior2000/10303435_138471283_big.jpg',
    ])
    expect(a.photoCount).toBe(2)
  })

  it('leaves description/coordinates/photos untouched when the expected boxes are missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html><body>gone</body></html>')))
    const a = makeAuction()
    await enrichOne(a)
    expect(a.description).toBeNull()
    expect(a.lat).toBeUndefined()
    expect(a.photoCount).toBe(1)
  })

  it('throws on upstream errors so the enrich task retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })))
    await expect(enrichOne(makeAuction())).rejects.toThrow('502')
  })
})
