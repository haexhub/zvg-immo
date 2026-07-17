import { describe, expect, it } from 'vitest'
import { extractSingleVerkehrswert, parseMvDateTime, stripAzPrefix, stripDivHtml } from './text'

describe('parseMvDateTime', () => {
  it('combines German date + time into iso + label', () => {
    expect(parseMvDateTime('28.08.2026', '10:00')).toEqual({
      iso: '2026-08-28T10:00:00',
      label: '28.08.2026, 10:00 Uhr',
    })
  })

  it('returns nulls for a missing date', () => {
    expect(parseMvDateTime(null, '10:00')).toEqual({ iso: null, label: null })
    expect(parseMvDateTime(undefined, undefined)).toEqual({ iso: null, label: null })
  })

  it('falls back to midnight when time is missing', () => {
    expect(parseMvDateTime('28.08.2026', null)).toEqual({
      iso: '2026-08-28T00:00:00',
      label: '28.08.2026',
    })
  })
})

describe('stripAzPrefix', () => {
  it('strips the leading "<az>: " prefix', () => {
    expect(
      stripAzPrefix(
        '68 K 30-25: Wohngebäude (technisch und wirtschaftlich überaltert) in Rostock - Lichtenhagen',
        '68 K 30-25',
      ),
    ).toBe('Wohngebäude (technisch und wirtschaftlich überaltert) in Rostock - Lichtenhagen')
  })

  it('returns the title unchanged when it does not start with the Aktenzeichen', () => {
    expect(stripAzPrefix('Wohngebäude in Rostock', '68 K 30-25')).toBe('Wohngebäude in Rostock')
  })
})

describe('stripDivHtml', () => {
  it('turns <br> into newlines and strips tags', () => {
    expect(
      stripDivHtml(
        '<div class="divHTML">Grundstück, Größe: 618 m²<br><br><B>Verkehrswert: 125.000,00 €</B></div>',
      ),
    ).toBe('Grundstück, Größe: 618 m²\n\nVerkehrswert: 125.000,00 €')
  })

  it('collapses runs of blank lines to one blank line', () => {
    expect(stripDivHtml('<div>A</div><div></div><div></div><div>B</div>')).toBe('A\n\nB')
  })
})

describe('extractSingleVerkehrswert', () => {
  it('extracts a single value from the free text', () => {
    expect(
      extractSingleVerkehrswert('Grundstück, Größe: 618 m²\n\nVerkehrswert: 75.500,00 €\n\nDer Versteigerungsvermerk...'),
    ).toEqual({ eur: 75500, text: '75.500,00 €' })
  })

  it('tolerates a repeated identical value', () => {
    expect(
      extractSingleVerkehrswert('Verkehrswert: 88.000,00 €\nHinweis: Verkehrswert: 88.000,00 €'),
    ).toEqual({ eur: 88000, text: '88.000,00 €' })
  })

  it('returns null for multi-lot texts with several per-lot values', () => {
    expect(
      extractSingleVerkehrswert('Verkehrswert: 75.500,00 €\n...\nVerkehrswert: 66.500,00 €'),
    ).toBeNull()
  })

  it('returns null when no value is present', () => {
    expect(extractSingleVerkehrswert('Grundstück in Warin, Größe: 618 m²')).toBeNull()
  })
})
