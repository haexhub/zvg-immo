import { describe, expect, it } from 'vitest'
import { currencyToEur, eurToCurrency } from './currency-convert'

const RATES = { SEK: 11.2, CZK: 25, GBP: 0.85 }

describe('eurToCurrency', () => {
  it('converts EUR to a target currency using units-of-currency-per-EUR', () => {
    expect(eurToCurrency(1000, 'SEK', RATES)).toBe(11200)
  })

  it('treats currency=EUR as identity', () => {
    expect(eurToCurrency(1000, 'EUR', RATES)).toBe(1000)
  })

  it('returns null for a currency missing from the rates table', () => {
    expect(eurToCurrency(1000, 'XYZ', RATES)).toBeNull()
  })
})

describe('currencyToEur', () => {
  it('converts a target-currency amount back to EUR', () => {
    expect(currencyToEur(11200, 'SEK', RATES)).toBeCloseTo(1000)
  })

  it('treats currency=EUR as identity', () => {
    expect(currencyToEur(1000, 'EUR', RATES)).toBe(1000)
  })

  it('returns null for a currency missing from the rates table', () => {
    expect(currencyToEur(1000, 'XYZ', RATES)).toBeNull()
  })

  it('round-trips through eurToCurrency', () => {
    const eur = 70512
    const converted = eurToCurrency(eur, 'CZK', RATES)!
    expect(currencyToEur(converted, 'CZK', RATES)).toBeCloseTo(eur)
  })
})
