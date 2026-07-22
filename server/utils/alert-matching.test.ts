import { describe, expect, it, vi } from 'vitest'

// toAuctionFilters resolves `${countryCode}:${regionCode}` pairs to
// `${countryCode}:${regionDisplayName}` via listCountries() — stub the
// registry with a small fixture instead of depending on the full, ever-
// growing list of real crawlers.
vi.mock('../crawlers/registry', () => ({
  listCountries: () => [
    {
      code: 'de',
      name: 'Deutschland',
      regions: [{ code: 'sn', name: 'Sachsen', platforms: [] }],
    },
  ],
}))

const { toAuctionFilters } = await import('./alert-matching')

describe('toAuctionFilters', () => {
  it('parses the stored query-param shape (saved_searches.filters) into AuctionFilters', () => {
    const filters = toAuctionFilters({
      country: 'de',
      region: 'de:sn',
      q: 'Wohnung',
      authority: 'AG Dresden',
      priceMin: '100000',
      priceMax: '',
      landMin: '500',
      category: 'einfamilienhaus',
      condition: 'gepflegt',
      features: 'balkon,garage',
      photos: '1',
      cancelled: '1',
    })

    expect(filters.countries).toEqual(['de'])
    expect(filters.regionNameKeys).toEqual(new Set(['de:Sachsen']))
    expect(filters.search).toBe('Wohnung')
    expect(filters.authority).toBe('AG Dresden')
    expect(filters.category).toBe('einfamilienhaus')
    expect(filters.condition).toBe('gepflegt')
    expect(filters.features).toEqual(['balkon', 'garage'])
    expect(filters.onlyWithPhotos).toBe(true)
    expect(filters.includeCancelled).toBe(true)
    expect(filters.priceMin).toBe(100000)
    expect(filters.priceMax).toBeNull()
    expect(filters.landMin).toBe(500)
    expect(filters.landMax).toBeNull()
  })

  it('defaults to no restriction / authority=all / category=all on an empty stored object', () => {
    const filters = toAuctionFilters({})
    expect(filters.countries).toEqual([])
    expect(filters.regionNameKeys).toBeNull()
    expect(filters.authority).toBe('all')
    expect(filters.category).toBe('all')
    expect(filters.condition).toBe('all')
    expect(filters.features).toEqual([])
    expect(filters.onlyWithPhotos).toBe(false)
    expect(filters.includeCancelled).toBe(false)
    expect(filters.priceMin).toBeNull()
  })

  it('drops region keys that no longer resolve against the current registry', () => {
    const filters = toAuctionFilters({ region: 'de:unknown-region' })
    expect(filters.regionNameKeys).toEqual(new Set())
  })
})
