import { describe, expect, it } from 'vitest'
import { parseMvDateTime, stripAzPrefix, stripDivHtml } from './text'

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
