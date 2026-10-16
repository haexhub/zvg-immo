import { describe, expect, it } from 'vitest'
import { extractDescriptionMarketValue } from './description-market-value'

describe('extractDescriptionMarketValue', () => {
  it('uses an explicitly stated total for a multi-part auction', () => {
    expect(extractDescriptionMarketValue(
      'Verkehrswert: 59.000 €\nVerkehrswert: 400 €\nGesamtwert: 62.400 €',
    )).toMatchObject({ eur: 62_400 })
  })

  it('sums the stated values when no overall total is published', () => {
    expect(extractDescriptionMarketValue(
      'Verkehrswert: 59.000 €\nVerkehrswert: 400 €\nVerkehrswert: 3.000 €',
    )).toMatchObject({ eur: 62_400 })
  })
})
