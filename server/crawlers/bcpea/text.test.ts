import { describe, expect, it } from 'vitest'
import {
  buildAddress,
  clean,
  cleanMultiline,
  formatPrice,
  isLandTitle,
  isNonPropertyTitle,
  parseAreaSqm,
  parseDateTime,
  parsePrice,
  parseRoomCount,
} from './text'

describe('clean', () => {
  it('collapses whitespace runs to single spaces', () => {
    expect(clean('  Иван   Петров ')).toBe('Иван Петров')
  })

  it('returns null for empty or whitespace-only input', () => {
    expect(clean('')).toBeNull()
    expect(clean('   ')).toBeNull()
    expect(clean(null)).toBeNull()
    expect(clean(undefined)).toBeNull()
  })
})

describe('cleanMultiline', () => {
  it('keeps line breaks while collapsing horizontal whitespace runs', () => {
    expect(cleanMultiline('САМОСТОЯТЕЛЕН   ОБЕКТ\n  Втори ред.  ')).toBe('САМОСТОЯТЕЛЕН ОБЕКТ\nВтори ред.')
  })

  it('collapses blank-line runs to a single blank line', () => {
    expect(cleanMultiline('Първи ред.\n\n\n\nВтори ред.')).toBe('Първи ред.\n\nВтори ред.')
  })

  it('returns null for empty or whitespace-only input', () => {
    expect(cleanMultiline('')).toBeNull()
    expect(cleanMultiline('   ')).toBeNull()
    expect(cleanMultiline(null)).toBeNull()
    expect(cleanMultiline(undefined)).toBeNull()
  })
})

describe('parsePrice', () => {
  it('parses a price with NBSP thousands separators and an EUR suffix', () => {
    expect(parsePrice('92 480.00 EUR')).toBe(92480)
  })

  it('rejects zero and null/undefined', () => {
    expect(parsePrice('0.00 EUR')).toBeNull()
    expect(parsePrice(null)).toBeNull()
    expect(parsePrice(undefined)).toBeNull()
  })
})

describe('formatPrice', () => {
  it('formats with thousands separators and a trailing euro sign', () => {
    expect(formatPrice(92480)).toBe('92.480 €')
  })

  it('returns null for null input', () => {
    expect(formatPrice(null)).toBeNull()
  })
})

describe('parseAreaSqm', () => {
  it('parses an area with NBSP thousands separators', () => {
    expect(parseAreaSqm('52 558.00 кв.м')).toBe(52558)
  })

  it('parses a plain decimal area', () => {
    expect(parseAreaSqm('55.74 кв.м')).toBe(55.74)
  })

  it('returns null for zero/missing input', () => {
    expect(parseAreaSqm(null)).toBeNull()
    expect(parseAreaSqm(undefined)).toBeNull()
  })
})

describe('parseDateTime', () => {
  it('parses a plain date+time as naive local Sofia time', () => {
    expect(parseDateTime('02.10.2026 10:00')).toEqual({
      iso: '2026-10-02T10:00:00',
      label: '02.10.2026, 10:00 Uhr',
    })
  })

  it('parses the first date out of a "от X до Y" range, ignoring the second', () => {
    expect(parseDateTime('от 01.09.2026 до 01.10.2026')).toEqual({
      iso: '2026-09-01T00:00:00',
      label: '01.09.2026',
    })
  })

  it('returns nulls for missing/unparseable input', () => {
    expect(parseDateTime(null)).toEqual({ iso: null, label: null })
    expect(parseDateTime('unbekannt')).toEqual({ iso: null, label: null })
  })
})

describe('isLandTitle', () => {
  it('recognises plot and agricultural-land titles', () => {
    expect(isLandTitle('Парцел')).toBe(true)
    expect(isLandTitle('Земеделска земя')).toBe(true)
    expect(isLandTitle('Земеделски имот')).toBe(true)
    expect(isLandTitle('Парцел с къща')).toBe(true)
  })

  it('does not flag apartments, houses or commercial lots as land', () => {
    expect(isLandTitle('Двустаен апартамент')).toBe(false)
    expect(isLandTitle('Търговски имот')).toBe(false)
    expect(isLandTitle(null)).toBe(false)
  })
})

describe('parseRoomCount', () => {
  it('maps the room-count adjective prefix to a number', () => {
    expect(parseRoomCount('Едностаен апартамент')).toBe(1)
    expect(parseRoomCount('Двустаен апартамент')).toBe(2)
    expect(parseRoomCount('Тристаен апартамент')).toBe(3)
  })

  it('returns null for titles without a known room-count prefix', () => {
    expect(parseRoomCount('Многостаен апартамент')).toBeNull()
    expect(parseRoomCount('Къща')).toBeNull()
    expect(parseRoomCount(null)).toBeNull()
  })
})

describe('isNonPropertyTitle', () => {
  it('flags vehicle and generic asset lots', () => {
    expect(isNonPropertyTitle('МПС')).toBe(true)
    expect(isNonPropertyTitle('Имущество')).toBe(true)
  })

  it('does not flag real-estate titles', () => {
    expect(isNonPropertyTitle('Двустаен апартамент')).toBe(false)
    expect(isNonPropertyTitle('Парцел')).toBe(false)
    expect(isNonPropertyTitle(null)).toBe(false)
  })
})

describe('buildAddress', () => {
  it('joins street and settlement, richest part first', () => {
    expect(buildAddress('с. Езерец', 'местност „ПЪТ ЗА ЛЕТИЩЕТО"')).toBe(
      'местност „ПЪТ ЗА ЛЕТИЩЕТО", с. Езерец, Bulgarien',
    )
  })

  it('falls back to whichever single part is present', () => {
    expect(buildAddress('с. Бранище', null)).toBe('с. Бранище, Bulgarien')
    expect(buildAddress(null, null)).toBeNull()
  })
})
