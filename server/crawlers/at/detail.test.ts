import { describe, expect, it } from 'vitest'
import { parseDetail } from './detail'

/** Renders the Bootstrap-style label rows the Lotus-Domino detail pages use
 *  (structure verified live against BG Steyr / BG Urfahr Edikte, 2026-07-17). */
function detailHtml(rows: Array<[string, string]>): string {
  const body = rows
    .map(
      ([label, value]) =>
        `<div class="row"><span class="col-sm-3 text-muted">${label}:</span><p class="col-sm-9">${value}</p></div>`,
    )
    .join('\n')
  return `<html><body><div id="title2">BG Steyr, 12 E 117/26m</div>${body}</body></html>`
}

const BASE_ROWS: Array<[string, string]> = [
  ['Dienststelle', 'BG Steyr (492)'],
  ['Aktenzeichen', '12 E 117/26m'],
  ['Versteigerungstermin', 'am 17.8.2026 um 10:30 Uhr'],
  ['Versteigerungsort', 'Bezirksgericht Steyr, Saal A Erdgeschoss'],
  ['Grundbuch', '45101 Asten'],
  ['EZ', '159'],
  ['Liegenschaftsadresse', 'Edelweißstraße 9'],
  ['PLZ/Ort', '4481 Asten'],
  ['Kategorie(n)', 'Einfamilienhaus'],
  ['Beschreibung (WE)', 'Teilunterkellertes Wohnhaus mit Erdgeschoss und Obergeschoss.'],
  ['Grundstücksgröße', '1.438 m²'],
  ['Objektgröße', '536,02 m²'],
  ['Schätzwert', '350.000,00 EUR'],
  ['Vadium', '35.000,00 EUR'],
  ['Geringstes Gebot', '175.000,00 EUR'],
]

describe('parseDetail', () => {
  it('maps Objektgröße to living area for Wohnung/Haus categories', () => {
    const info = parseDetail(detailHtml(BASE_ROWS))
    expect(info.sourceLivingAreaSqm).toBe(536.02)
    expect(info.sourceLandAreaSqm).toBe(1438)
    expect(info.schaetzwertEur).toBe(350000)
    expect(info.aktenzeichen).toBe('12 E 117/26m')
    expect(info.adresse).toBe('Edelweißstraße 9, 4481 Asten')
  })

  it('maps Objektgröße to land area for Grundstück categories', () => {
    const rows = BASE_ROWS.filter(([l]) => !['Kategorie(n)', 'Grundstücksgröße', 'Objektgröße'].includes(l))
    rows.push(['Kategorie(n)', 'Grundstück'], ['Objektgröße', '800 m²'])
    const info = parseDetail(detailHtml(rows))
    expect(info.sourceLivingAreaSqm).toBeNull()
    expect(info.sourceLandAreaSqm).toBe(800)
  })

  it('keeps Objektgröße out of the structured fields when the category is unclear', () => {
    const rows = BASE_ROWS.filter(([l]) => !['Kategorie(n)', 'Grundstücksgröße'].includes(l))
    const info = parseDetail(detailHtml(rows))
    expect(info.sourceLivingAreaSqm).toBeNull()
    expect(info.sourceLandAreaSqm).toBeNull()
    expect(info.beschreibung).toContain('Objektgröße: 536,02 m²')
  })

  it('adds the labeled info block to the beschreibung', () => {
    const info = parseDetail(detailHtml(BASE_ROWS))
    const b = info.beschreibung ?? ''
    expect(b).toContain('Teilunterkellertes Wohnhaus')
    expect(b).toContain('Kategorie: Einfamilienhaus')
    expect(b).toContain('Objektgröße: 536,02 m²')
    expect(b).toContain('Grundstücksgröße: 1.438 m²')
    expect(b).toContain('Versteigerungsort: Bezirksgericht Steyr, Saal A Erdgeschoss')
    expect(b).toContain('Vadium: 35.000,00 EUR')
    expect(b).toContain('Geringstes Gebot: 175.000,00 EUR')
    expect(b).toContain('Grundbuch: 45101 Asten, EZ 159')
  })

  it('omits Grundbuch from the beschreibung when the row is not the short form', () => {
    const rows = BASE_ROWS.filter(([l]) => l !== 'Grundbuch')
    rows.push(['Grundbuch', 'x'.repeat(80)])
    expect(parseDetail(detailHtml(rows)).beschreibung).not.toContain('Grundbuch:')
  })

  it('still exposes vadium/geringstes Gebot/versteigerungsOrt as fields', () => {
    const info = parseDetail(detailHtml(BASE_ROWS))
    expect(info.vadiumText).toBe('35.000,00 EUR')
    expect(info.geringstesGebotText).toBe('175.000,00 EUR')
    expect(info.versteigerungsOrt).toBe('Bezirksgericht Steyr, Saal A Erdgeschoss')
  })
})
