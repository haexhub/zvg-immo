import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'
import { parseDetailHtml, enrichOne } from './detail'
import { parseLivingAreaSqm } from './text'

// enrichOne converts PLN → EUR; pin the rate so the assertions are stable.
vi.mock('~/server/utils/exchange-rate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/utils/exchange-rate')>()),
  getRates: vi.fn().mockResolvedValue({ PLN: 4 }),
}))

/** Trimmed-down detail page mirroring the live SSR markup (notice 45036, Juli 2026). */
const DETAIL_HTML = `
<div class="notice-template-wrapper notice-template-wrapper--auctions">
  <div class="notice-template">
    <p>
      Komornik Sądowy<br/>
      przy Sądzie Rejonowym w Zgorzelcu Remigiusz Kapusta<br/>
      Kancelaria Komornicza nr II w Zgorzelcu<br/>
      Dionizego Czachowskiego 7/1<br/>
      59-900 Zgorzelec
    </p>
    <p> Sygnatura: Km 314/18</p>
    <p class="notice-template-content-text h6"> OBWIESZCZENIE O DRUGIEJ LICYTACJI NIERUCHOMOŚCI</p>
    <div class="template-items">
      <div class="template-item">
        <div class="template-item-content">
          <div class="template-item-header">
            <div class="template-item-title">
              <div class="template-item-value">
                <h4>lokal mieszkalny</h4>
                lokal mieszkalny nr 13, umieszczony na parterze i I piętrze budynku mieszkalnego położonego przy ul. Żołnierzy II AWP 20 w mieście Bogatynia. Lokal wraz z pomieszczeniami przynależnymi posiada powierzchnię użytkową 70,80 m kw (część mieszkalna 51,50 m kw, garaż 15,00 m kw, pomieszczenie gospodarcze 4,30 m kw).
              </div>
            </div>
          </div>
          <div class="template-item-attributes">
            <div class="template-item-attribute">
              <div class="template-item-label">Adres nieruchomości</div>
              <div class="template-item-value">
                Żołnierzy II AWP 20/13, 59-916 Bogatynia, poczta Bogatynia
              </div>
            </div>
          </div>
          <div class="template-item-attributes">
            <div class="template-item-attribute">
              <div class="template-item-label">Cena wywołania</div>
              <div class="template-item-value">
                86 666,67 zł<br/>
                (2/3 ceny sumy oszacowania)
              </div>
            </div>
            <div class="template-item-attribute">
              <div class="template-item-label">Najniższe postąpienie</div>
              <div class="template-item-value">867,00 zł</div>
            </div>
            <div class="template-item-attribute">
              <div class="template-item-label">Suma oszacowania</div>
              <div class="template-item-value">
                130 000,00 zł
              </div>
            </div>
          </div>
          <div class="template-item-attributes">
            <div class="template-item-attribute">
              <div class="template-item-label">Wysokość rękojmi</div>
              <div class="template-item-value">13 000,00 zł</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
`

describe('parseDetailHtml', () => {
  const detail = parseDetailHtml(DETAIL_HTML)

  it('extracts the lot description without the h4 heading', () => {
    expect(detail.beschreibung).toMatch(/^lokal mieszkalny nr 13, umieszczony/)
    expect(detail.beschreibung).not.toMatch(/^lokal mieszkalny lokal/)
  })

  it('extracts the Sygnatura as aktenzeichen', () => {
    expect(detail.aktenzeichen).toBe('Km 314/18')
  })

  it('extracts the court independently from the Sygnatura', () => {
    expect(detail.amtsgericht).toBe('Sąd Rejonowy w Zgorzelcu')
  })

  it('extracts Suma oszacowania and Cena wywołania in PLN', () => {
    expect(detail.sumaOszacowaniaPln).toBe(130000)
    expect(detail.cenaWywolaniaPln).toBe(86667)
  })

  it('extracts the living area from the description', () => {
    expect(detail.livingAreaSqm).toBe(70.8)
  })

  it('handles footnote labels, VAT suffixes and plural Sygnatury (notice 45040/45030 variants)', () => {
    const variant = parseDetailHtml(`
      <p> Sygnatury: \n        Km 1022/19, KM 489/19; KM 1563/20</p>
      <div class="template-item-attribute">
        <div class="template-item-label">Cena wywołania*</div>
        <div class="template-item-value">249 750,00 zł<br/>(3/4 ceny sumy oszacowania)</div>
      </div>
      <div class="template-item-attribute">
        <div class="template-item-label">Suma oszacowania</div>
        <div class="template-item-value">333 000,00 zł (w tym VAT 0%)</div>
      </div>
    `)
    expect(variant.aktenzeichen).toBe('Km 1022/19')
    expect(variant.cenaWywolaniaPln).toBe(249750)
    expect(variant.sumaOszacowaniaPln).toBe(333000)
  })

  it('returns nulls for a page without the notice template', () => {
    expect(parseDetailHtml('<div>błąd</div>')).toEqual({
      beschreibung: null,
      aktenzeichen: null,
      amtsgericht: null,
      sumaOszacowaniaPln: null,
      cenaWywolaniaPln: null,
      livingAreaSqm: null,
    })
  })

  it('takes no structured price/area from multi-lot notices', () => {
    const multi = parseDetailHtml(`
      <p> Sygnatura: Km 1/20</p>
      <div class="template-items">
        <div class="template-item">
          <div class="template-item-title"><div class="template-item-value">
            <h4>lokal mieszkalny</h4>lokal nr 1 o powierzchni użytkowej 50,00 m kw
          </div></div>
          <div class="template-item-attribute">
            <div class="template-item-label">Suma oszacowania</div>
            <div class="template-item-value">100 000,00 zł</div>
          </div>
        </div>
        <div class="template-item">
          <div class="template-item-attribute">
            <div class="template-item-label">Suma oszacowania</div>
            <div class="template-item-value">50 000,00 zł</div>
          </div>
        </div>
      </div>`)
    expect(multi.sumaOszacowaniaPln).toBeNull()
    expect(multi.cenaWywolaniaPln).toBeNull()
    expect(multi.livingAreaSqm).toBeNull()
    // Notice-level fields still apply to the auction as a whole.
    expect(multi.aktenzeichen).toBe('Km 1/20')
    expect(multi.beschreibung).toMatch(/^lokal nr 1/)
  })
})

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'pl-komornik',
    country: 'pl',
    region: 'Dolnośląskie',
    zvgId: '45036',
    aktenzeichen: '',
    amtsgericht: '',
    objekt: 'Licytacja nieruchomości lokal mieszkalny',
    adresse: 'Żołnierzy II AWP 20/13, 59-916 Bogatynia, Polen',
    verkehrswertEur: null,
    verkehrswertText: null,
    terminIso: '2026-08-10',
    terminText: '10.08.2026 13:00',
    aufgehoben: false,
    letzteAktualisierungIso: null,
    pdfUrl: null,
    detailUrl: 'https://licytacje.komornik.pl/wyszukiwarka/obwieszczenia-o-licytacji/45036/licytacja-nieruchomosci-lokal-mieszkalny',
    pdfUrlUpstream: null,
    detailUrlUpstream: 'https://licytacje.komornik.pl/wyszukiwarka/obwieszczenia-o-licytacji/45036/licytacja-nieruchomosci-lokal-mieszkalny',
    attachments: [],
    beschreibung: null,
    fotoCount: 0,
    thumbnailUrl: null,
    ...overrides,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('enrichOne', () => {
  it('fills beschreibung, Sygnatura, Wohnfläche and converts the Suma oszacowania to EUR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(DETAIL_HTML)))
    const a = makeAuction()
    await enrichOne(a)
    expect(a.beschreibung).toMatch(/^lokal mieszkalny nr 13, umieszczony/)
    expect(a.aktenzeichen).toBe('Km 314/18')
    expect(a.amtsgericht).toBe('Sąd Rejonowy w Zgorzelcu')
    expect(a.sourceLivingAreaSqm).toBe(70.8)
    // 130 000 zł Suma oszacowania at 4 PLN per EUR — not the Cena wywołania.
    expect(a.verkehrswertEur).toBe(32500)
    expect(a.verkehrswertText).toBe('130.000 zł')
  })

  it('falls back to the Cena wywołania when no Suma oszacowania is published', async () => {
    const html = `
      <div class="notice-template-wrapper">
        <div class="template-item-attribute">
          <div class="template-item-label">Cena wywołania</div>
          <div class="template-item-value">100 000,00 zł</div>
        </div>
      </div>`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(html)))
    const a = makeAuction()
    await enrichOne(a)
    expect(a.verkehrswertEur).toBe(25000)
    expect(a.verkehrswertText).toBe('100.000 zł')
  })

  it('throws on upstream errors so the enrich task retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })))
    await expect(enrichOne(makeAuction())).rejects.toThrow('500')
  })

  it('throws on a WAF/error page instead of silently succeeding', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<div>Access denied</div>')))
    await expect(enrichOne(makeAuction())).rejects.toThrow('unexpected page')
  })
})

describe('parseLivingAreaSqm', () => {
  it('parses declensed "powierzchnia użytkowa" phrases', () => {
    expect(parseLivingAreaSqm('posiada powierzchnię użytkową 70,80 m kw')).toBe(70.8)
    expect(parseLivingAreaSqm('o powierzchni użytkowej 51,5 m²')).toBe(51.5)
    expect(parseLivingAreaSqm('powierzchnia użytkowa: 120 m2')).toBe(120)
  })

  it('parses the "powierzchnia lokalu wynosi" variant', () => {
    expect(parseLivingAreaSqm('Powierzchnia lokalu mieszkalnego wynosi: 42,02 m2.')).toBe(42.02)
    expect(parseLivingAreaSqm('powierzchni użytkowej 102,66 mkw., budynek')).toBe(102.66)
  })

  it('ignores texts without a usable-area phrase', () => {
    expect(parseLivingAreaSqm('działka o powierzchni 1200 m kw')).toBeNull()
    expect(parseLivingAreaSqm('')).toBeNull()
  })
})
