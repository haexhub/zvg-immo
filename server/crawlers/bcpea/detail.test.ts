import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { enrichOne } from './detail'

const DETAIL_HTML = `
<html><body>
<div class="wrapper wrapper-single">
  <div class="item__expanded">
    <div class="col col--images">
      <div class="head">
        <a class="item-image" href="/upload/91381/455825/20260804_125953.jpg">
          <img src="/upload/91381/455825/20260804_125953.jpg?w=270&amp;h=270" />
        </a>
      </div>
      <div class="is__row">
        <div class="img__wrapper">
          <a class="item-image" href="/upload/91381/455826/20260804_130225.jpg">
            <img src="/upload/91381/455826/20260804_130225.jpg?w=270&amp;h=270"/>
          </a>
        </div>
      </div>
    </div>
    <div class="col col--info">
      <div class="label__group">
        <div class="label">ПЛОЩ</div>
        <div class="info">55.74 кв.м</div>
      </div>
      <div class="label__group">
        <div class="label">Населено място</div>
        <div class="info">гр. Нови Искър</div>
      </div>
      <div class="label__group">
        <div class="label">ОКРЪЖЕН СЪД</div>
        <div class="info">София град</div>
      </div>
      <div class="label__group">
        <div class="label">ЧАСТЕН СЪДЕБЕН ИЗПЪЛНИТЕЛ</div>
        <div class="info">Ренета Милчева Василева</div>
      </div>
      <div class="label__group">
        <div class="label">Сканирани обявления</div>
        <div class="info">
          <ul>
            <li><a target="_blank" href="/upload/91381/455824/обявление 1894-26.pdf">обявление 1894-26.pdf</a></li>
          </ul>
        </div>
      </div>
      <div class="label__group label__group-description">
        <div class="label">ОПИСАНИЕ</div>
        <div class="info"><p align="justify"><span>САМОСТОЯТЕЛЕН ОБЕКТ</span>&nbsp;В СГРАДА.<br/>Втори ред.</p></div>
      </div>
    </div>
  </div>
</div>
<div class="wrapper-similar">
  <div class="item__group">
    <div class="col col--grow">
      <div class="header">
        <div class="title">Земеделска земя</div>
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
    </div>
    <div class="col col--image">
      <a href="/properties/91370">
        <img src="/assets/images/photo-placeholder.png" />
      </a>
    </div>
  </div>
</div>
</body></html>
`

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'bg-bcpea',
    country: 'bg',
    region: 'София град',
    externalId: '91381',
    caseNumber: '',
    authority: 'Ренета Милчева Василева',
    title: 'Двустаен апартамент',
    address: 'гр. Нови Искър, Bulgarien',
    marketValueEur: 92800,
    marketValueText: '92.800 €',
    startingBid: 92800,
    auctionDateIso: '2026-09-29T09:00:00',
    auctionDateText: '29.09.2026, 09:00 Uhr',
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: 'https://sales.bcpea.org/properties/91381',
    pdfUrlUpstream: null,
    detailUrlUpstream: 'https://sales.bcpea.org/properties/91381',
    attachments: [],
    description: null,
    photoCount: 1,
    thumbnailUrl: 'https://sales.bcpea.org/upload/91381/455825/20260804_125953.jpg?w=270&h=270',
    ...overrides,
  }
}

beforeEach(() => vi.stubGlobal('useRuntimeConfig', () => ({})))
afterEach(() => vi.unstubAllGlobals())

describe('enrichOne', () => {
  it('extracts description, PDF attachment and full-res gallery scoped to the main object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(DETAIL_HTML)))
    const a = makeAuction()
    await enrichOne(a)

    expect(a.description).toBe('САМОСТОЯТЕЛЕН ОБЕКТ В СГРАДА.\nВтори ред.')

    expect(a.attachments).toHaveLength(1)
    expect(a.attachments[0]).toMatchObject({
      kind: 'announcement',
      filename: 'обявление 1894-26.pdf',
      proxyUrl: 'https://sales.bcpea.org/upload/91381/455824/обявление 1894-26.pdf',
    })

    // Full-res href, not the ?w=270&h=270 thumbnail src — and only this
    // object's own two gallery photos, never the unrelated "similar
    // properties" card's placeholder further down the same page.
    expect(a.photoUrls).toEqual([
      'https://sales.bcpea.org/upload/91381/455825/20260804_125953.jpg',
      'https://sales.bcpea.org/upload/91381/455826/20260804_130225.jpg',
    ])
    expect(a.photoCount).toBe(2)
    expect(a.thumbnailUrl).toBe('https://sales.bcpea.org/upload/91381/455825/20260804_125953.jpg')
  })

  it('leaves photos/description untouched when the info box is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html><body>gone</body></html>')))
    const a = makeAuction()
    await enrichOne(a)
    expect(a.description).toBeNull()
    expect(a.photoCount).toBe(1)
    expect(a.thumbnailUrl).toBe('https://sales.bcpea.org/upload/91381/455825/20260804_125953.jpg?w=270&h=270')
  })

  it('throws on upstream errors so the enrich task retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })))
    await expect(enrichOne(makeAuction())).rejects.toThrow('502')
  })
})
