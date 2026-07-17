import { describe, expect, it } from 'vitest'
import { parseSqmAt } from './text'

describe('parseSqmAt', () => {
  it('parses Austrian-formatted areas', () => {
    expect(parseSqmAt('876 m²')).toBe(876)
    expect(parseSqmAt('320,00 m²')).toBe(320)
    expect(parseSqmAt('1.438 m²')).toBe(1438)
    expect(parseSqmAt('17.219 m²')).toBe(17219)
  })

  it('accepts m2 spelling and non-breaking spaces', () => {
    expect(parseSqmAt('112,64 m2')).toBe(112.64)
    expect(parseSqmAt('112,64 m²')).toBe(112.64)
  })

  it('returns null for missing or non-numeric values', () => {
    expect(parseSqmAt(null)).toBeNull()
    expect(parseSqmAt(undefined)).toBeNull()
    expect(parseSqmAt('siehe Gutachten')).toBeNull()
  })
})
