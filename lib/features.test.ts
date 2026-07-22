import { describe, expect, it } from 'vitest'
import { FEATURES } from './features'

describe('FEATURES', () => {
  it('has no duplicates', () => {
    expect(new Set(FEATURES).size).toBe(FEATURES.length)
  })
  it('is non-empty', () => {
    expect(FEATURES.length).toBeGreaterThan(0)
  })
})
