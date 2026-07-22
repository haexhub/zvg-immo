import { describe, expect, it } from 'vitest'
import { CONDITIONS } from './condition'

describe('CONDITIONS', () => {
  it('has no duplicates', () => {
    expect(new Set(CONDITIONS).size).toBe(CONDITIONS.length)
  })
  it('is ordered best to worst, neuwertig first and baufaellig last', () => {
    expect(CONDITIONS[0]).toBe('neuwertig')
    expect(CONDITIONS[CONDITIONS.length - 1]).toBe('baufaellig')
  })
})
