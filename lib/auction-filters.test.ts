import { describe, expect, it } from 'vitest'
import { auctionCategory, filterAuctions, hasCompletedLlmAnalysis, scopeByCountryRegion, type AuctionFilters } from './auction-filters'
import type { Auction } from '~/types/auction'

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'de-bawue',
    country: 'de',
    region: 'Baden-Württemberg',
    externalId: '1',
    caseNumber: '12 K 1/24',
    authority: 'Amtsgericht Stuttgart',
    title: 'Einfamilienhaus',
    address: 'Musterstraße 1, 70173 Stuttgart',
    marketValueEur: 200_000,
    marketValueText: null,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
    ...overrides,
  }
}

const BASE_FILTERS: AuctionFilters = {
  countries: [],
  regionNameKeys: null,
  search: '',
  authority: 'all',
  category: 'all',
  condition: 'all',
  features: [],
  onlyWithPhotos: false,
  includeCancelled: false,
  hideRulesOnly: false,
  priceMin: null,
  priceMax: null,
  landMin: null,
  landMax: null,
  livMin: null,
  livMax: null,
  yearBuiltMin: null,
  yearBuiltMax: null,
  renovationYearMin: null,
  renovationYearMax: null,
}

describe('scopeByCountryRegion', () => {
  const items = [
    makeAuction({ externalId: '1', country: 'de', region: 'Bayern' }),
    makeAuction({ externalId: '2', country: 'es', region: 'Madrid' }),
    makeAuction({ externalId: '3', country: 'de', region: 'Sachsen' }),
  ]

  it('returns everything unchanged when no country/region restriction is set', () => {
    expect(scopeByCountryRegion(items, [], null)).toEqual(items)
  })

  it('filters by country', () => {
    const result = scopeByCountryRegion(items, ['de'], null)
    expect(result.map((a) => a.externalId)).toEqual(['1', '3'])
  })

  it('filters by region name key (country:region)', () => {
    const result = scopeByCountryRegion(items, [], new Set(['de:Sachsen']))
    expect(result.map((a) => a.externalId)).toEqual(['3'])
  })

  it('combines country and region restrictions', () => {
    const result = scopeByCountryRegion(items, ['de', 'es'], new Set(['es:Madrid']))
    expect(result.map((a) => a.externalId)).toEqual(['2'])
  })
})

describe('auctionCategory', () => {
  it('prefers extraction.propertyType over classifyPropertyType(title)', () => {
    const a = makeAuction({ title: 'Garage', extraction: {
      propertyType: 'einfamilienhaus', landAreaSqm: null, livingAreaSqm: null, rooms: null,
      units: null, source: 'rules', confidence: 'high', at: '2024-01-01T00:00:00Z',
    } })
    expect(auctionCategory(a).id).toBe('einfamilienhaus')
  })

  it('falls back to classifyPropertyType(title) when extraction is absent', () => {
    const a = makeAuction({ title: 'Garage', extraction: null })
    expect(auctionCategory(a).id).toBe('garage-stellplatz')
  })

  it('falls back to classifyPropertyType(title) when extraction.propertyType is null', () => {
    const a = makeAuction({ title: 'Garage', extraction: {
      propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null,
      units: null, source: 'rules', confidence: 'low', at: '2024-01-01T00:00:00Z',
    } })
    expect(auctionCategory(a).id).toBe('garage-stellplatz')
  })
})

describe('filterAuctions', () => {
  it('excludes cancelled auctions by default', () => {
    const items = [makeAuction({ externalId: '1', cancelled: true }), makeAuction({ externalId: '2', cancelled: false })]
    expect(filterAuctions(items, BASE_FILTERS).map((a) => a.externalId)).toEqual(['2'])
  })

  it('includes cancelled auctions when includeCancelled is set', () => {
    const items = [makeAuction({ externalId: '1', cancelled: true }), makeAuction({ externalId: '2', cancelled: false })]
    const result = filterAuctions(items, { ...BASE_FILTERS, includeCancelled: true })
    expect(result.map((a) => a.externalId)).toEqual(['1', '2'])
  })

  it('filters by authority (amtsgericht)', () => {
    const items = [
      makeAuction({ externalId: '1', authority: 'Amtsgericht Stuttgart' }),
      makeAuction({ externalId: '2', authority: 'Amtsgericht München' }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, authority: 'Amtsgericht München' })
    expect(result.map((a) => a.externalId)).toEqual(['2'])
  })

  it('filters by Objektart (category)', () => {
    const items = [
      makeAuction({ externalId: '1', title: 'Einfamilienhaus' }),
      makeAuction({ externalId: '2', title: 'Garage' }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, category: 'garage-stellplatz' })
    expect(result.map((a) => a.externalId)).toEqual(['2'])
  })

  it('filters onlyWithPhotos', () => {
    const items = [
      makeAuction({ externalId: '1', photoCount: 0 }),
      makeAuction({ externalId: '2', photoCount: 3 }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, onlyWithPhotos: true })
    expect(result.map((a) => a.externalId)).toEqual(['2'])
  })

  it('filters hideRulesOnly, treating only entries without a completed LLM pass as rules-only', () => {
    const items = [
      makeAuction({ externalId: '1', extraction: {
        propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null,
        units: null, source: 'rules', confidence: 'low', at: '2024-01-01T00:00:00Z',
      } }),
      makeAuction({ externalId: '2', extraction: {
        propertyType: 'einfamilienhaus', landAreaSqm: null, livingAreaSqm: null, rooms: null,
        units: null, source: 'llm', confidence: 'high', at: '2024-01-01T00:00:00Z',
      } }),
      makeAuction({ externalId: '3', extraction: null }),
      makeAuction({ externalId: '4', extraction: {
        propertyType: 'einfamilienhaus', landAreaSqm: 700, livingAreaSqm: null, rooms: null,
        units: null, source: 'rules', confidence: 'high', at: '2024-01-01T00:00:00Z',
        llmAnalyzedAt: '2024-01-01T00:00:00Z',
      } }),
      makeAuction({ externalId: '5', extraction: {
        propertyType: 'einfamilienhaus', landAreaSqm: 700, livingAreaSqm: null, rooms: null,
        units: null, source: 'rules', confidence: 'high', at: '2024-01-01T00:00:00Z',
        condition: null,
      } }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, hideRulesOnly: true })
    expect(result.map((a) => a.externalId)).toEqual(['2', '4', '5'])
  })

  it('detects completed LLM analysis even when confident rules kept the source', () => {
    expect(hasCompletedLlmAnalysis({
      propertyType: 'einfamilienhaus',
      landAreaSqm: 1316,
      livingAreaSqm: 180,
      rooms: null,
      units: null,
      source: 'rules',
      confidence: 'high',
      at: '2026-07-28T20:38:01.425Z',
      llmAnalyzedAt: '2026-07-28T20:38:01.425Z',
    })).toBe(true)
  })

  it('filters by Verkehrswert range, excluding null values once a bound is set', () => {
    const items = [
      makeAuction({ externalId: '1', marketValueEur: 50_000 }),
      makeAuction({ externalId: '2', marketValueEur: 250_000 }),
      makeAuction({ externalId: '3', marketValueEur: null }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, priceMin: 100_000, priceMax: 400_000 })
    expect(result.map((a) => a.externalId)).toEqual(['2'])
  })

  it('filters by land area range, requiring extraction.landAreaSqm once a bound is set', () => {
    const items = [
      makeAuction({ externalId: '1', extraction: { propertyType: null, landAreaSqm: 300, livingAreaSqm: null, rooms: null, units: null, source: 'rules', confidence: 'high', at: '' } }),
      makeAuction({ externalId: '2', extraction: { propertyType: null, landAreaSqm: 900, livingAreaSqm: null, rooms: null, units: null, source: 'rules', confidence: 'high', at: '' } }),
      makeAuction({ externalId: '3', extraction: null }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, landMin: 500, landMax: 1000 })
    expect(result.map((a) => a.externalId)).toEqual(['2'])
  })

  it('filters by living area range, requiring extraction.livingAreaSqm once a bound is set', () => {
    const items = [
      makeAuction({ externalId: '1', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: 60, rooms: null, units: null, source: 'rules', confidence: 'high', at: '' } }),
      makeAuction({ externalId: '2', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: 140, rooms: null, units: null, source: 'rules', confidence: 'high', at: '' } }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, livMin: 100 })
    expect(result.map((a) => a.externalId)).toEqual(['2'])
  })

  it('filters by year built range, requiring extraction.yearBuilt once a bound is set', () => {
    const items = [
      makeAuction({ externalId: '1', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null, units: null, source: 'llm', confidence: 'low', yearBuilt: 1950, at: '' } }),
      makeAuction({ externalId: '2', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null, units: null, source: 'llm', confidence: 'low', yearBuilt: 2010, at: '' } }),
      makeAuction({ externalId: '3', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null, units: null, source: 'llm', confidence: 'low', yearBuilt: null, at: '' } }),
      makeAuction({ externalId: '4', extraction: null }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, yearBuiltMin: 2000 })
    expect(result.map((a) => a.externalId)).toEqual(['2'])
  })

  it('filters by renovation year range, requiring extraction.lastRenovationYear once a bound is set', () => {
    const items = [
      makeAuction({ externalId: '1', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null, units: null, source: 'llm', confidence: 'low', lastRenovationYear: 2005, at: '' } }),
      makeAuction({ externalId: '2', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null, units: null, source: 'llm', confidence: 'low', lastRenovationYear: 2020, at: '' } }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, renovationYearMin: 2015 })
    expect(result.map((a) => a.externalId)).toEqual(['2'])
  })

  it('filters by minimum condition, excluding auctions without a known condition once set', () => {
    const items = [
      makeAuction({ externalId: '1', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null, units: null, source: 'llm', confidence: 'low', condition: 'neuwertig', features: [], at: '' } }),
      makeAuction({ externalId: '2', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null, units: null, source: 'llm', confidence: 'low', condition: 'gepflegt', features: [], at: '' } }),
      makeAuction({ externalId: '3', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null, units: null, source: 'llm', confidence: 'low', condition: 'baufaellig', features: [], at: '' } }),
      makeAuction({ externalId: '4', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null, units: null, source: 'llm', confidence: 'low', condition: null, features: [], at: '' } }),
      makeAuction({ externalId: '5', extraction: null }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, condition: 'gepflegt' })
    expect(result.map((a) => a.externalId)).toEqual(['1', '2'])
  })

  it('filters by features with OR semantics', () => {
    const items = [
      makeAuction({ externalId: '1', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null, units: null, source: 'llm', confidence: 'low', features: ['balkon'], at: '' } }),
      makeAuction({ externalId: '2', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null, units: null, source: 'llm', confidence: 'low', features: ['garage'], at: '' } }),
      makeAuction({ externalId: '3', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null, units: null, source: 'llm', confidence: 'low', features: ['keller'], at: '' } }),
      makeAuction({ externalId: '4', extraction: null }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, features: ['balkon', 'garage'] })
    expect(result.map((a) => a.externalId)).toEqual(['1', '2'])
  })

  it('matches free-text search case-insensitively across Aktenzeichen/Amtsgericht/Objekt/Adresse/Beschreibung', () => {
    const items = [
      makeAuction({ externalId: '1', description: 'Schöne Aussicht auf den See' }),
      makeAuction({ externalId: '2', description: 'Ruhige Lage' }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, search: 'AUSSICHT' })
    expect(result.map((a) => a.externalId)).toEqual(['1'])
  })

  it('trims the search term before matching', () => {
    const items = [makeAuction({ externalId: '1', title: 'Einfamilienhaus' })]
    const result = filterAuctions(items, { ...BASE_FILTERS, search: '  einfamilienhaus  ' })
    expect(result.map((a) => a.externalId)).toEqual(['1'])
  })

  it('combines country/region scoping with the rest of the filter pipeline', () => {
    const items = [
      makeAuction({ externalId: '1', country: 'de', region: 'Bayern', marketValueEur: 500_000 }),
      makeAuction({ externalId: '2', country: 'de', region: 'Sachsen', marketValueEur: 500_000 }),
      makeAuction({ externalId: '3', country: 'es', region: 'Madrid', marketValueEur: 500_000 }),
    ]
    const result = filterAuctions(items, {
      ...BASE_FILTERS,
      countries: ['de'],
      regionNameKeys: new Set(['de:Sachsen']),
      priceMin: 100_000,
    })
    expect(result.map((a) => a.externalId)).toEqual(['2'])
  })
})
