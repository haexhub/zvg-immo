import { describe, expect, it } from 'vitest'
import {
  activeAuctionSearchFilterCount,
  defaultAuctionSearchFilters,
  parseAuctionSearchFilters,
  serializeAuctionSearchFilters,
  unsupportedAlertFilterKeys,
} from './auction-search-filter-contract'

describe('auction search filter contract', () => {
  it('round-trips every persisted URL filter without changing its canonical value', () => {
    const query = {
      country: 'de,at', region: 'de:sn,at:w', q: 'Haus', authority: 'AG Dresden',
      priceMin: '100000', priceMax: '200000', landMin: '100', landMax: '500', livMin: '80', livMax: '150',
      yearBuiltMin: '1900', yearBuiltMax: '2020', renovationYearMin: '2000', renovationYearMax: '2025',
      nearSea: '5', nearLake: '6', nearRiver: '7', nearMountain: '8', nearAirport: '9', nearSki: '10',
      nearSkiDownhill: '11', nearSkiNordic: '12',
      urbanRural: 'rural', nearLat: '52.5', nearLng: '13.4', nearRadius: '25', category: 'haus',
      condition: 'gepflegt,neuwertig', features: 'balkon,garage', photos: '1', cancelled: '1', llmOnly: '0', sort: 'priceAsc',
    }
    expect(serializeAuctionSearchFilters(parseAuctionSearchFilters(query, true), true)).toEqual(query)
  })

  it('uses defaults for empty or invalid values and does not turn empty numbers into zero', () => {
    expect(parseAuctionSearchFilters({ priceMin: '', sort: 'wrong' })).toEqual(defaultAuctionSearchFilters())
  })

  it('counts a coordinate search once and identifies filters alerts cannot evaluate', () => {
    const filters = parseAuctionSearchFilters({ nearLat: '52.5', nearLng: '13.4', nearSea: '5' })
    expect(activeAuctionSearchFilterCount(filters)).toBe(2)
    expect(unsupportedAlertFilterKeys(filters)).toEqual(['nearSea'])
  })

  it('defaults a saved coordinate pair without a radius to 25km so distance filtering stays executable', () => {
    const filters = parseAuctionSearchFilters({ nearLat: '52.5', nearLng: '13.4' })
    expect(filters.nearRadius).toBe(25)
  })
})
