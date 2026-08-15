import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { aggregateMarketValue, applyMarketValueTextAggregation } from './market-value-aggregation'

describe('aggregateMarketValue', () => {
  it('prefers a source-provided total over its component values', () => {
    expect(aggregateMarketValue([59_000, 400, 3_000], 62_400)).toBe(62_400)
  })

  it('sums all parts when the source does not provide a total', () => {
    expect(aggregateMarketValue([59_000, 400, 3_000])).toBe(62_400)
  })

  it('keeps a single market value unchanged and ignores invalid parts', () => {
    expect(aggregateMarketValue([120_000, null, 0, -50])).toBe(120_000)
  })

  it('applies the rule for any crawler based on its raw market-value text', () => {
    const auction = {
      marketValue: 1_509_059_000,
      marketValueEur: 1_509_059_000,
      marketValueText: 'WE Blatt 15090 59.000,00; Flurstück 400,00; Küche 3.000,00; Gesamtwert: 62.400,00',
      currency: 'EUR',
    } as Auction
    applyMarketValueTextAggregation(auction)
    expect(auction.marketValue).toBe(62_400)
    expect(auction.marketValueEur).toBe(62_400)
  })

  it('sums unlabelled parts in a non-German source format', () => {
    const auction = {
      marketValue: 0,
      marketValueEur: null,
      marketValueText: 'Lot A: 45,000.00 GBP; Lot B: 55,000.00 GBP',
      currency: 'GBP',
    } as Auction
    applyMarketValueTextAggregation(auction)
    expect(auction.marketValue).toBe(100_000)
  })
})
