import { describe, expect, it } from 'vitest'
import {
  absoluteUrl,
  buildAddress,
  clean,
  cleanMultiline,
  extractLatLng,
  formatPrice,
  parseAreaSqm,
  parsePrice,
  parseRoomCount,
} from './text'

describe('clean', () => {
  it('collapses whitespace runs to single spaces', () => {
    expect(clean('  Левски   В ')).toBe('Левски В')
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
    expect(cleanMultiline('Инвеститор   и строител.\n  В сградите има.  ')).toBe(
      'Инвеститор и строител.\nВ сградите има.',
    )
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

describe('absoluteUrl', () => {
  it('leaves absolute URLs untouched', () => {
    expect(absoluteUrl('https://www.alo.bg/user_files/x.jpg')).toBe('https://www.alo.bg/user_files/x.jpg')
  })

  it('resolves a bare relative path against BASE_URL, same as the <base href> the site itself sets', () => {
    expect(absoluteUrl('user_files/p/partnior2000/10303435_139838417_big.jpg')).toBe(
      'https://www.alo.bg/user_files/p/partnior2000/10303435_139838417_big.jpg',
    )
  })

  it('resolves a leading-slash path without doubling the slash', () => {
    expect(absoluteUrl('/template/images/icons/vip.svg')).toBe('https://www.alo.bg/template/images/icons/vip.svg')
  })
})

describe('parsePrice', () => {
  it('parses a price with NBSP thousands separators and a euro sign', () => {
    expect(parsePrice('210 332 €')).toBe(210332)
  })

  it('rejects zero and null/undefined', () => {
    expect(parsePrice('0 €')).toBeNull()
    expect(parsePrice(null)).toBeNull()
    expect(parsePrice(undefined)).toBeNull()
  })
})

describe('formatPrice', () => {
  it('formats with thousands separators and a trailing euro sign', () => {
    expect(formatPrice(210332)).toBe('210.332 €')
  })

  it('returns null for null input', () => {
    expect(formatPrice(null)).toBeNull()
  })
})

describe('parseAreaSqm', () => {
  it('parses a plain "<number> кв.м" field (apartments\' Квадратура/Двор)', () => {
    expect(parseAreaSqm('120 кв.м')).toBe(120)
  })

  it('parses a field with a trailing label suffix (houses\' РЗП)', () => {
    expect(parseAreaSqm('63 кв.м РЗП')).toBe(63)
  })

  it('parses NBSP thousands separators', () => {
    expect(parseAreaSqm('1 200 кв.м')).toBe(1200)
  })

  it('returns null for zero/missing input', () => {
    expect(parseAreaSqm(null)).toBeNull()
    expect(parseAreaSqm(undefined)).toBeNull()
    expect(parseAreaSqm('РЗП')).toBeNull()
  })
})

describe('parseRoomCount', () => {
  it('maps the room-count adjective prefix of "Вид на имота" to a number', () => {
    expect(parseRoomCount('Едностаен апартамент в София')).toBe(1)
    expect(parseRoomCount('Тристаен апартамент в София')).toBe(3)
  })

  it('returns null for a field without a known room-count prefix (houses have no such field at all)', () => {
    expect(parseRoomCount('Многостаен апартамент')).toBe(5)
    expect(parseRoomCount('Триетажна къща в Банкя')).toBeNull()
    expect(parseRoomCount(null)).toBeNull()
  })
})

describe('buildAddress', () => {
  it('cleans whitespace and appends the country', () => {
    expect(buildAddress('Левски В, София')).toBe('Левски В, София, Bulgarien')
  })

  it('collapses a double space (e.g. "област  София") before appending', () => {
    expect(buildAddress('Банкя, област  София')).toBe('Банкя, област София, Bulgarien')
  })

  it('returns null when no address is given', () => {
    expect(buildAddress(null)).toBeNull()
  })
})

describe('extractLatLng', () => {
  it('parses lat/lng out of the Google Maps "q=" query param', () => {
    expect(extractLatLng('https://maps.google.com/?q=42.70782814288973,23.377624846945093&ll=42.7,23.3&z=18&t=m')).toEqual(
      { lat: 42.70782814288973, lng: 23.377624846945093 },
    )
  })

  it('returns nulls when the href is missing or has no q= param', () => {
    expect(extractLatLng(null)).toEqual({ lat: null, lng: null })
    expect(extractLatLng('https://maps.google.com/?z=18')).toEqual({ lat: null, lng: null })
  })
})
