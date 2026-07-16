import { describe, expect, it } from 'vitest'
import { clean, formatGrPrice, parseGrDateTime, parseGrPrice } from './text'

describe('clean', () => {
  it('collapses whitespace runs to single spaces', () => {
    expect(clean('  Αττικής,\n  Αθήνα ')).toBe('Αττικής, Αθήνα')
  })

  it('returns null for empty or whitespace-only input', () => {
    expect(clean('')).toBeNull()
    expect(clean('   \n ')).toBeNull()
    expect(clean(null)).toBeNull()
    expect(clean(undefined)).toBeNull()
  })
})

describe('parseGrDateTime', () => {
  it('parses "22/07/2026 10:00" into iso + German label', () => {
    expect(parseGrDateTime('22/07/2026 10:00')).toEqual({
      iso: '2026-07-22T10:00:00',
      label: '22.07.2026, 10:00 Uhr',
    })
  })

  it('returns nulls for text without the slash-date pattern', () => {
    expect(parseGrDateTime('άγνωστη ημερομηνία')).toEqual({ iso: null, label: null })
  })

  it('returns nulls for null/undefined input', () => {
    expect(parseGrDateTime(null)).toEqual({ iso: null, label: null })
    expect(parseGrDateTime(undefined)).toEqual({ iso: null, label: null })
  })
})

describe('parseGrPrice', () => {
  it('passes through positive numbers', () => {
    expect(parseGrPrice(76000)).toBe(76000)
  })

  it('returns null for zero, negative, null or undefined', () => {
    expect(parseGrPrice(0)).toBeNull()
    expect(parseGrPrice(-5)).toBeNull()
    expect(parseGrPrice(null)).toBeNull()
    expect(parseGrPrice(undefined)).toBeNull()
  })
})

describe('formatGrPrice', () => {
  it('formats with German thousands separator and a euro sign', () => {
    expect(formatGrPrice(76000)).toBe('76.000 €')
  })

  it('returns null for null input', () => {
    expect(formatGrPrice(null)).toBeNull()
  })
})
