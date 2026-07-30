import { describe, expect, it } from 'vitest'
import { clean, formatBgDateText, formatBgPrice, parseBgAddress, parseBgPrice, stripBgHtml } from './text'

describe('clean', () => {
  it('collapses whitespace runs to single spaces', () => {
    expect(clean('  Люба   Тодорова ')).toBe('Люба Тодорова')
  })

  it('returns null for empty or whitespace-only input', () => {
    expect(clean('')).toBeNull()
    expect(clean('   ')).toBeNull()
    expect(clean(null)).toBeNull()
    expect(clean(undefined)).toBeNull()
  })
})

describe('stripBgHtml', () => {
  it('strips tags, keeps paragraph breaks and decodes entities', () => {
    expect(stripBgHtml('<p><strong>АПАРТАМЕНТ</strong>&nbsp;№47</p><p>Втори ред.</p>')).toBe(
      'АПАРТАМЕНТ №47\nВтори ред.',
    )
  })

  it('decodes the &bdquo;/&ldquo; quote pair to a plain double quote', () => {
    expect(stripBgHtml('гр. Варна, кв. &bdquo;Св. Иван Рилски&ldquo; № 53')).toBe(
      'гр. Варна, кв. "Св. Иван Рилски" № 53',
    )
  })

  it('decodes common real-estate entities used by zapori descriptions', () => {
    expect(stripBgHtml('&frac12; идеална част &ndash; част ІІ')).toBe('1/2 идеална част – част ІІ')
  })

  it('returns an empty string for null/undefined input', () => {
    expect(stripBgHtml(null)).toBe('')
    expect(stripBgHtml(undefined)).toBe('')
  })
})

describe('parseBgPrice', () => {
  it('accepts positive numbers', () => {
    expect(parseBgPrice(136000)).toBe(136000)
  })

  it('rejects zero, negative and null/undefined', () => {
    expect(parseBgPrice(0)).toBeNull()
    expect(parseBgPrice(-5)).toBeNull()
    expect(parseBgPrice(null)).toBeNull()
    expect(parseBgPrice(undefined)).toBeNull()
  })
})

describe('formatBgPrice', () => {
  it('formats with thousands separators and a trailing euro sign', () => {
    expect(formatBgPrice(136000)).toBe('136.000 €')
  })

  it('returns null for null input', () => {
    expect(formatBgPrice(null)).toBeNull()
  })
})

describe('formatBgDateText', () => {
  it('converts a genuine UTC timestamp to Sofia local time', () => {
    // 06:00Z in September (EEST, UTC+3) is 09:00 local.
    expect(formatBgDateText('2026-09-17T06:00:00Z')).toBe('17.09.2026, 09:00 Uhr')
  })

  it('returns null for null/invalid input', () => {
    expect(formatBgDateText(null)).toBeNull()
    expect(formatBgDateText('not-a-date')).toBeNull()
  })
})

describe('parseBgAddress', () => {
  it('extracts a kvartal (кв.) address quoted with the &bdquo;/&ldquo; pair (already decoded to ")', () => {
    expect(
      parseBgAddress(
        'АПАРТАМЕНТ №47',
        'находящ се в гр. Варна, кв. "Св. Иван Рилски" № 53, идентичен със стар адрес',
      ),
    ).toBe('кв. Св. Иван Рилски № 53, гр. Варна, Bulgarien')
  })

  it('extracts the settlement from the title when the description has no match', () => {
    expect(parseBgAddress('Публична продан на земеделска земя - с. Костанденец', null)).toBe(
      'с. Костанденец, Bulgarien',
    )
  })

  it('extracts Bulgarian long-form village, municipality, province and locality text', () => {
    expect(
      parseBgAddress(
        'ОБЯВЛЕНИЕ ЗА ЕЛЕКТРОНЕН ПУБЛИЧЕН ТЪРГ НА НЕДВИЖИМ ИМОТ',
        'имот, находящ се в село Приселци, община Аврен, област Варна, местност "Пазарлията" – част ІІ',
      ),
    ).toBe('местност Пазарлията, село Приселци, община Аврен, област Варна, Bulgarien')
  })

  it('extracts a title-only street and number (no separate description)', () => {
    expect(parseBgAddress('АПАРТАМЕНТ  в гр.  БУРГАС, ул. "ОБОРИЩЕ" № 90, ет. 5, ап. 8', null)).toBe(
      'ул. ОБОРИЩЕ № 90, гр. БУРГАС, Bulgarien',
    )
  })

  it('returns null when neither title nor description name a settlement or street', () => {
    expect(parseBgAddress('ПИ 61128.14.37', 'УПИ № III-14001 с идентификатор 61128.14.37')).toBeNull()
  })
})
