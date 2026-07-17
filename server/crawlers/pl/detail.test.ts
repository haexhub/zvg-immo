import { describe, expect, it } from 'vitest'
import { parseDetailHtml } from './detail'
import { parseLivingAreaSqm } from './text'

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
      sumaOszacowaniaPln: null,
      cenaWywolaniaPln: null,
      livingAreaSqm: null,
    })
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
