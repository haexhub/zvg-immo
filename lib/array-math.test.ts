import { describe, expect, it } from 'vitest'
import { maxOf, minOf } from './array-math'

describe('minOf', () => {
  it('matches Math.min for small arrays', () => {
    expect(minOf([3, 1, 2])).toBe(1)
    expect(minOf([-5, 0, 5])).toBe(-5)
  })

  it('returns Infinity for an empty array, like Math.min()', () => {
    expect(minOf([])).toBe(Number.POSITIVE_INFINITY)
  })

  it('does not throw on arrays too large for Math.min(...values)', () => {
    const values = Array.from({ length: 200_000 }, (_, i) => i)
    expect(() => minOf(values)).not.toThrow()
    expect(minOf(values)).toBe(0)
  })
})

describe('maxOf', () => {
  it('matches Math.max for small arrays', () => {
    expect(maxOf([3, 1, 2])).toBe(3)
    expect(maxOf([-5, 0, 5])).toBe(5)
  })

  it('returns -Infinity for an empty array, like Math.max()', () => {
    expect(maxOf([])).toBe(Number.NEGATIVE_INFINITY)
  })

  it('does not throw on arrays too large for Math.max(...values)', () => {
    const values = Array.from({ length: 200_000 }, (_, i) => i)
    expect(() => maxOf(values)).not.toThrow()
    expect(maxOf(values)).toBe(199_999)
  })
})
