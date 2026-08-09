import { describe, expect, it, vi } from 'vitest'
import { filterAuctions } from '~/lib/auction-filters'
import type { Auction } from '~/types/auction'

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
      llmOnly: '1',
      nearLat: '52.5',
      nearLng: '13.4',
      nearRadius: '25',
      nearSea: '5',
      urbanRural: 'rural',
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
    expect(filters.hideRulesOnly).toBe(true)
    expect(filters.priceMin).toBe(100000)
    expect(filters.priceMax).toBeNull()
    expect(filters.landMin).toBe(500)
    expect(filters.landMax).toBeNull()
    expect(filters.nearLat).toBe(52.5)
    expect(filters.nearLng).toBe(13.4)
    expect(filters.nearRadius).toBe(25)
    expect(filters.nearSea).toBe(5)
    expect(filters.urbanRural).toBe('rural')
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
    expect(filters.hideRulesOnly).toBe(false)
    expect(filters.priceMin).toBeNull()
  })

  it('drops region keys that no longer resolve against the current registry', () => {
    const filters = toAuctionFilters({ region: 'de:unknown-region' })
    expect(filters.regionNameKeys).toEqual(new Set())
  })

  it('shares nearby-distance semantics with the in-memory alert evaluator', () => {
    const filters = toAuctionFilters({ nearLat: '52.52', nearLng: '13.405', nearRadius: '10' })
    const base: Auction = {
      platform: 'test', country: 'de', region: 'Sachsen', externalId: 'x', caseNumber: '1', authority: 'AG', title: null,
      address: null, marketValueEur: null, marketValueText: null, auctionDateIso: null, auctionDateText: null,
      cancelled: false, sourceUpdatedIso: null, pdfUrl: null, detailUrl: null, pdfUrlUpstream: null,
      detailUrlUpstream: null, attachments: [], description: null, photoCount: 0, thumbnailUrl: null,
    }
    expect(filterAuctions([
      { ...base, externalId: 'near', lat: 52.52, lng: 13.405 },
      { ...base, externalId: 'far', lat: 53.551, lng: 9.993 },
    ], filters).map((auction) => auction.externalId)).toEqual(['near'])
  })
})
