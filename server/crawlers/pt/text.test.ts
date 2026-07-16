import { describe, expect, it } from 'vitest'
import { clean, parsePtDateTime, parsePtPrice, formatPtPrice } from './text'

describe('clean', () => {
  it('collapses whitespace runs to single spaces', () => {
    expect(clean('  Rua  Esperança\n 67 ')).toBe('Rua Esperança 67')
  })

  it('returns null for empty or whitespace-only input', () => {
    expect(clean('')).toBeNull()
    expect(clean('   ')).toBeNull()
    expect(clean(null)).toBeNull()
    expect(clean(undefined)).toBeNull()
  })
})

describe('parsePtDateTime', () => {
  it('parses a timezone-less timestamp into iso + German label', () => {
    expect(parsePtDateTime('2026-07-21T14:30:00')).toEqual({
      iso: '2026-07-21T14:30:00',
      label: '21.07.2026, 14:30 Uhr',
    })
  })

  it('returns nulls for null input', () => {
    expect(parsePtDateTime(null)).toEqual({ iso: null, label: null })
  })

  it('returns nulls for unparseable input', () => {
    expect(parsePtDateTime('n/a')).toEqual({ iso: null, label: null })
  })
})

describe('parsePtPrice', () => {
  it('passes through positive numbers', () => {
    expect(parsePtPrice(100000)).toBe(100000)
  })

  it('returns null for zero, negative, or missing input', () => {
    expect(parsePtPrice(0)).toBeNull()
    expect(parsePtPrice(-5)).toBeNull()
    expect(parsePtPrice(null)).toBeNull()
    expect(parsePtPrice(undefined)).toBeNull()
  })
})

describe('formatPtPrice', () => {
  it('formats with German thousands separator and euro sign', () => {
    expect(formatPtPrice(100000)).toBe('100.000 €')
  })

  it('preserves cents instead of rounding to whole euros', () => {
    expect(formatPtPrice(125176.47)).toBe('125.176,47 €')
  })

  it('returns null for null input', () => {
    expect(formatPtPrice(null)).toBeNull()
  })
})
