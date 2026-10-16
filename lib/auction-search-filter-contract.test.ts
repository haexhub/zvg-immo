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
      platform: 'zvg-portal,dga-ag',
      condition: 'gepflegt,neuwertig', features: 'balkon,garage', photos: '1', cancelled: '1', llmOnly: '0', sort: 'priceAsc',
    }
    expect(serializeAuctionSearchFilters(parseAuctionSearchFilters(query, true), true)).toEqual(query)
  })

  it('normalizes country codes to the lowercase ISO form crawled auctions carry', () => {
    const filters = parseAuctionSearchFilters({ country: 'DE,de,At,xyz' })
    expect(filters.countries).toEqual(['de', 'at'])
    expect(serializeAuctionSearchFilters(filters)).toEqual({ country: 'de,at' })
  })

  it('keeps UI region keys and an explicit hideRulesOnly opt-out across a submit/parse round trip', () => {
    // The landing bar serializes its own refs and /search parses them back.
    const query = serializeAuctionSearchFilters(
      { ...defaultAuctionSearchFilters(), countries: ['de'], regionKeys: ['de:sn'], hideRulesOnly: false },
      true,
    )
    expect(query).toEqual({ country: 'de', region: 'de:sn', llmOnly: '0' })
    const parsed = parseAuctionSearchFilters(query, true)
    expect(parsed.regionKeys).toEqual(['de:sn'])
    expect(parsed.hideRulesOnly).toBe(false)
  })

  it('uses defaults for empty or invalid values and does not turn empty numbers into zero', () => {
    expect(parseAuctionSearchFilters({ priceMin: '', sort: 'wrong' })).toEqual(defaultAuctionSearchFilters())
  })

  it('counts a coordinate search once and identifies filters alerts cannot evaluate', () => {
    const filters = parseAuctionSearchFilters({ nearLat: '52.5', nearLng: '13.4', nearSea: '5' })
    expect(activeAuctionSearchFilterCount(filters)).toBe(2)
    expect(unsupportedAlertFilterKeys(filters)).toEqual(['nearSea'])
  })

  it('rejects extraction-backed alert filters a fresh list crawl can never satisfy', () => {
    const filters = parseAuctionSearchFilters({
      livMin: '0', yearBuiltMax: '2000', condition: 'gepflegt', features: 'balkon', photos: '1', llmOnly: '1',
      nearSea: '0', priceMin: '1000', category: 'einfamilienhaus',
    })
    expect(unsupportedAlertFilterKeys(filters)).toEqual([
      'livMin', 'yearBuiltMax', 'condition', 'features', 'onlyWithPhotos', 'hideRulesOnly',
    ])
    expect(unsupportedAlertFilterKeys(parseAuctionSearchFilters({ llmOnly: '0', priceMax: '5' }))).toEqual([])
  })

  it('defaults a saved coordinate pair without a radius to 25km so distance filtering stays executable', () => {
    const filters = parseAuctionSearchFilters({ nearLat: '52.5', nearLng: '13.4' })
    expect(filters.nearRadius).toBe(25)
  })

  it('drops coordinates outside the WGS84 ranges before they reach PostGIS', () => {
    expect(parseAuctionSearchFilters({ nearLat: '90.1', nearLng: '13.4', nearRadius: '25' })).toMatchObject({
      nearLat: null, nearLng: 13.4, nearRadius: 25,
    })
    expect(parseAuctionSearchFilters({ nearLat: '52.5', nearLng: '180.1', nearRadius: '25' })).toMatchObject({
      nearLat: 52.5, nearLng: null, nearRadius: 25,
    })
  })
})
