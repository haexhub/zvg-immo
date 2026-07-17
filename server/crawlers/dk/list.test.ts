import { describe, expect, it } from 'vitest'
import { parseAuctionDate } from './list'

describe('parseAuctionDate', () => {
  it('parses a two-digit hour', () => {
    expect(parseAuctionDate('17.08.2026, 13.30')).toEqual({
      iso: '2026-08-17T13:30:00',
      label: '17.08.2026, 13:30 Uhr',
    })
  })

  it('parses a single-digit hour (morning slots) and pads it', () => {
    expect(parseAuctionDate('19.08.2026, 9.30')).toEqual({
      iso: '2026-08-19T09:30:00',
      label: '19.08.2026, 09:30 Uhr',
    })
  })

  it('returns nulls for missing or unparseable input', () => {
    expect(parseAuctionDate(null)).toEqual({ iso: null, label: null })
    expect(parseAuctionDate(undefined)).toEqual({ iso: null, label: null })
    expect(parseAuctionDate('efter aftale')).toEqual({ iso: null, label: null })
  })
})
