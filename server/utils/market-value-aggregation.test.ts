import { describe, expect, it } from 'vitest'
import { aggregateMarketValue } from './market-value-aggregation'

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
})
