import { describe, expect, it } from 'vitest'
import { mapRow, type RawRow } from './list'

function makeRow(overrides: Partial<RawRow> = {}): RawRow {
  return {
    AuctionID: 123456,
    Asset_Title: 'Franklin County, PA Sheriff Sale: 761 FREY ROAD',
    ActualCloseTime: '2026-09-11T15:00:00',
    MinimumBid: 15000,
    DebtAmount: 87000,
    CourtCase: '2025-CV-1234',
    SheriffNumber: null,
    Defendant: 'John Doe',
    Plaintiff: 'Some Bank',
    Township: 'Guilford Township',
    Attorney: 'Some Law Firm',
    Address: '761 FREY ROAD, CHAMBERSBURG, PA',
    IsPostponedOrStayed: false,
    Images: null,
    ...overrides,
  }
}

describe('mapRow', () => {
  it('sets startingBid from MinimumBid', () => {
    const a = mapRow(makeRow(), [], 'us-bid4assets')
    expect(a.startingBid).toBe(15000)
  })

  it('leaves startingBid null when MinimumBid is absent', () => {
    const a = mapRow(makeRow({ MinimumBid: null }), [], 'us-bid4assets')
    expect(a.startingBid).toBeNull()
  })

  it('never derives marketValueEur from DebtAmount or MinimumBid', () => {
    const a = mapRow(makeRow(), [], 'us-bid4assets')
    expect(a.marketValueEur).toBeNull()
    expect(a.marketValueText).toBeNull()
  })
})
