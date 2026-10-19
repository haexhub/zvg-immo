import { describe, expect, it } from 'vitest'
import { hasUsableCoordinates, usableCoordinates } from './coordinates'

describe('hasUsableCoordinates', () => {
  it('accepts a real position, including one on the equator or the prime meridian', () => {
    expect(hasUsableCoordinates(48.0079, 7.8107)).toBe(true)
    expect(hasUsableCoordinates(0, 7.8)).toBe(true)
    expect(hasUsableCoordinates(48, 0)).toBe(true)
  })

  it('rejects null island, the value sources use for "no location"', () => {
    expect(hasUsableCoordinates(0, 0)).toBe(false)
  })

  it('rejects missing, non-finite and out-of-range values', () => {
    expect(hasUsableCoordinates(null, 8)).toBe(false)
    expect(hasUsableCoordinates(48, undefined)).toBe(false)
    expect(hasUsableCoordinates(Number.NaN, 8)).toBe(false)
    expect(hasUsableCoordinates(91, 8)).toBe(false)
    expect(hasUsableCoordinates(48, 181)).toBe(false)
  })
  it('usableCoordinates hands back the pair, or null', () => {
    expect(usableCoordinates(48, 8)).toEqual({ lat: 48, lng: 8 })
    expect(usableCoordinates(0, 0)).toBeNull()
  })
})
