import { describe, expect, it } from 'vitest'
import { fixMojibake, parseEuro } from './text'

describe('fixMojibake', () => {
  it('repairs "GÃ¶rlitz" to "Görlitz"', () => {
    expect(fixMojibake('GÃ¶rlitz')).toBe('Görlitz')
  })

  it('repairs "MÃ¼nchen" to "München"', () => {
    expect(fixMojibake('MÃ¼nchen')).toBe('München')
  })

  it('leaves clean strings unchanged', () => {
    expect(fixMojibake('Görlitz')).toBe('Görlitz')
  })
})

describe('parseEuro', () => {
  it('parses a total without decimals ahead of per-parcel sub-amounts', () => {
    expect(
      parseEuro('74.800 €, wobei auf die einzelnen Parzellen entfallen: lfd. Nr. 1: 500 €'),
    ).toBe(74800)
  })

  it('parses German decimal amounts', () => {
    expect(parseEuro('123.456,78 €')).toBe(123456.78)
  })

  it('parses EUR-suffixed amounts with decimals', () => {
    expect(parseEuro('74.800,50 EUR')).toBe(74800.5)
  })

  it('still parses bare amounts without a currency marker', () => {
    expect(parseEuro('800.000,00')).toBe(800000)
  })

  it('uses the highest value when the portal lists several lots and a total', () => {
    expect(parseEuro(
      '1. WE 46 Blatt 15090&nbsp; 59.000,00\n' +
      '2. Flst. 1402/10, 1/192 Miteigentumsanteil 400,00\n' +
      'Einbauküche: 3.000,00\nGesamtwert: 62.400,00',
    )).toBe(62400)
  })

  it('does not ignore an unmarked Gesamtwert when a lot has a euro marker', () => {
    expect(parseEuro('Wohnung: 59.000,00 €; Gesamtwert: 62.400,00')).toBe(62400)
  })

  it('decodes &euro; entities before matching', () => {
    expect(parseEuro('16.100,00&nbsp;&euro;')).toBe(16100)
  })

  it('returns null for text without a euro amount', () => {
    expect(parseEuro('siehe Gutachten')).toBeNull()
  })
})
