import { describe, expect, it } from 'vitest'
import { clean, parseSiDateTime, parseSiPrice, formatSiPrice, parseSiRooms, parseSiCoord } from './text'

describe('clean', () => {
  it('collapses whitespace runs to single spaces', () => {
    expect(clean('  Rakuševa\n  ulica ')).toBe('Rakuševa ulica')
  })

  it('returns null for empty or whitespace-only input', () => {
    expect(clean('')).toBeNull()
    expect(clean('   ')).toBeNull()
    expect(clean(null)).toBeNull()
    expect(clean(undefined)).toBeNull()
  })
})

describe('parseSiDateTime', () => {
  it('parses a "Z"-suffixed timestamp as literal wall-clock time', () => {
    expect(parseSiDateTime('2026-11-26T10:45:00Z')).toEqual({
      iso: '2026-11-26T10:45:00',
      label: '26.11.2026, 10:45 Uhr',
    })
  })

  it('returns nulls for null input', () => {
    expect(parseSiDateTime(null)).toEqual({ iso: null, label: null })
  })

  it('returns nulls for unparseable input', () => {
    expect(parseSiDateTime('not a date')).toEqual({ iso: null, label: null })
  })
})

describe('parseSiPrice', () => {
  it('parses numeric strings from the API', () => {
    expect(parseSiPrice('12690')).toBe(12690)
    expect(parseSiPrice('12690.50')).toBe(12690.5)
  })

  it('accepts numbers directly', () => {
    expect(parseSiPrice(12690)).toBe(12690)
  })

  it('returns null for zero, negative, or missing input', () => {
    expect(parseSiPrice('0')).toBeNull()
    expect(parseSiPrice('-5')).toBeNull()
    expect(parseSiPrice(null)).toBeNull()
    expect(parseSiPrice(undefined)).toBeNull()
  })
})

describe('formatSiPrice', () => {
  it('formats with German thousands separator and euro sign', () => {
    expect(formatSiPrice(12690)).toBe('12.690 €')
  })

  it('returns null for null input', () => {
    expect(formatSiPrice(null)).toBeNull()
  })
})

describe('parseSiRooms', () => {
  it('parses "N-sobno" room categories', () => {
    expect(parseSiRooms('1-sobno')).toBe(1)
    expect(parseSiRooms('3-sobno')).toBe(3)
  })

  it('returns null for non-numeric or half-room categories', () => {
    expect(parseSiRooms('Garsonjera')).toBeNull()
    expect(parseSiRooms('1,5-sobno')).toBeNull()
    expect(parseSiRooms(null)).toBeNull()
    expect(parseSiRooms(undefined)).toBeNull()
  })
})

describe('parseSiCoord', () => {
  it('parses coordinate strings', () => {
    expect(parseSiCoord('46.076706')).toBe(46.076706)
  })

  it('returns null for empty or unparseable input', () => {
    expect(parseSiCoord('')).toBeNull()
    expect(parseSiCoord(null)).toBeNull()
    expect(parseSiCoord('n/a')).toBeNull()
  })
})
