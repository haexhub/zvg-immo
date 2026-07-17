import { describe, expect, it } from 'vitest'
import { auctionKategorie, filterAuctions, scopeByCountryRegion, type AuctionFilters } from './auction-filters'
import type { Auction } from '~/types/auction'

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'de-bawue',
    country: 'de',
    region: 'Baden-Württemberg',
    zvgId: '1',
    aktenzeichen: '12 K 1/24',
    amtsgericht: 'Amtsgericht Stuttgart',
    objekt: 'Einfamilienhaus',
    adresse: 'Musterstraße 1, 70173 Stuttgart',
    verkehrswertEur: 200_000,
    verkehrswertText: null,
    terminIso: null,
    terminText: null,
    aufgehoben: false,
    letzteAktualisierungIso: null,
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    beschreibung: null,
    fotoCount: 0,
    thumbnailUrl: null,
    ...overrides,
  }
}

const BASE_FILTERS: AuctionFilters = {
  countries: [],
  regionNameKeys: null,
  search: '',
  court: 'all',
  kategorie: 'all',
  onlyWithPhotos: false,
  includeAufgehoben: false,
  priceMin: null,
  priceMax: null,
  landMin: null,
  landMax: null,
  livMin: null,
  livMax: null,
}

describe('scopeByCountryRegion', () => {
  const items = [
    makeAuction({ zvgId: '1', country: 'de', region: 'Bayern' }),
    makeAuction({ zvgId: '2', country: 'es', region: 'Madrid' }),
    makeAuction({ zvgId: '3', country: 'de', region: 'Sachsen' }),
  ]

  it('returns everything unchanged when no country/region restriction is set', () => {
    expect(scopeByCountryRegion(items, [], null)).toEqual(items)
  })

  it('filters by country', () => {
    const result = scopeByCountryRegion(items, ['de'], null)
    expect(result.map((a) => a.zvgId)).toEqual(['1', '3'])
  })

  it('filters by region name key (country:region)', () => {
    const result = scopeByCountryRegion(items, [], new Set(['de:Sachsen']))
    expect(result.map((a) => a.zvgId)).toEqual(['3'])
  })

  it('combines country and region restrictions', () => {
    const result = scopeByCountryRegion(items, ['de', 'es'], new Set(['es:Madrid']))
    expect(result.map((a) => a.zvgId)).toEqual(['2'])
  })
})

describe('auctionKategorie', () => {
  it('prefers extraction.propertyType over classifyObjekt(objekt)', () => {
    const a = makeAuction({ objekt: 'Garage', extraction: {
      propertyType: 'einfamilienhaus', landAreaSqm: null, livingAreaSqm: null, rooms: null,
      units: null, source: 'rules', confidence: 'high', at: '2024-01-01T00:00:00Z',
    } })
    expect(auctionKategorie(a).id).toBe('einfamilienhaus')
  })

  it('falls back to classifyObjekt(objekt) when extraction is absent', () => {
    const a = makeAuction({ objekt: 'Garage', extraction: null })
    expect(auctionKategorie(a).id).toBe('garage-stellplatz')
  })

  it('falls back to classifyObjekt(objekt) when extraction.propertyType is null', () => {
    const a = makeAuction({ objekt: 'Garage', extraction: {
      propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null,
      units: null, source: 'rules', confidence: 'low', at: '2024-01-01T00:00:00Z',
    } })
    expect(auctionKategorie(a).id).toBe('garage-stellplatz')
  })
})

describe('filterAuctions', () => {
  it('excludes aufgehoben auctions by default', () => {
    const items = [makeAuction({ zvgId: '1', aufgehoben: true }), makeAuction({ zvgId: '2', aufgehoben: false })]
    expect(filterAuctions(items, BASE_FILTERS).map((a) => a.zvgId)).toEqual(['2'])
  })

  it('includes aufgehoben auctions when includeAufgehoben is set', () => {
    const items = [makeAuction({ zvgId: '1', aufgehoben: true }), makeAuction({ zvgId: '2', aufgehoben: false })]
    const result = filterAuctions(items, { ...BASE_FILTERS, includeAufgehoben: true })
    expect(result.map((a) => a.zvgId)).toEqual(['1', '2'])
  })

  it('filters by court (amtsgericht)', () => {
    const items = [
      makeAuction({ zvgId: '1', amtsgericht: 'Amtsgericht Stuttgart' }),
      makeAuction({ zvgId: '2', amtsgericht: 'Amtsgericht München' }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, court: 'Amtsgericht München' })
    expect(result.map((a) => a.zvgId)).toEqual(['2'])
  })

  it('filters by Objektart (kategorie)', () => {
    const items = [
      makeAuction({ zvgId: '1', objekt: 'Einfamilienhaus' }),
      makeAuction({ zvgId: '2', objekt: 'Garage' }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, kategorie: 'garage-stellplatz' })
    expect(result.map((a) => a.zvgId)).toEqual(['2'])
  })

  it('filters onlyWithPhotos', () => {
    const items = [
      makeAuction({ zvgId: '1', fotoCount: 0 }),
      makeAuction({ zvgId: '2', fotoCount: 3 }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, onlyWithPhotos: true })
    expect(result.map((a) => a.zvgId)).toEqual(['2'])
  })

  it('filters by Verkehrswert range, excluding null values once a bound is set', () => {
    const items = [
      makeAuction({ zvgId: '1', verkehrswertEur: 50_000 }),
      makeAuction({ zvgId: '2', verkehrswertEur: 250_000 }),
      makeAuction({ zvgId: '3', verkehrswertEur: null }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, priceMin: 100_000, priceMax: 400_000 })
    expect(result.map((a) => a.zvgId)).toEqual(['2'])
  })

  it('filters by land area range, requiring extraction.landAreaSqm once a bound is set', () => {
    const items = [
      makeAuction({ zvgId: '1', extraction: { propertyType: null, landAreaSqm: 300, livingAreaSqm: null, rooms: null, units: null, source: 'rules', confidence: 'high', at: '' } }),
      makeAuction({ zvgId: '2', extraction: { propertyType: null, landAreaSqm: 900, livingAreaSqm: null, rooms: null, units: null, source: 'rules', confidence: 'high', at: '' } }),
      makeAuction({ zvgId: '3', extraction: null }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, landMin: 500, landMax: 1000 })
    expect(result.map((a) => a.zvgId)).toEqual(['2'])
  })

  it('filters by living area range, requiring extraction.livingAreaSqm once a bound is set', () => {
    const items = [
      makeAuction({ zvgId: '1', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: 60, rooms: null, units: null, source: 'rules', confidence: 'high', at: '' } }),
      makeAuction({ zvgId: '2', extraction: { propertyType: null, landAreaSqm: null, livingAreaSqm: 140, rooms: null, units: null, source: 'rules', confidence: 'high', at: '' } }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, livMin: 100 })
    expect(result.map((a) => a.zvgId)).toEqual(['2'])
  })

  it('matches free-text search case-insensitively across Aktenzeichen/Amtsgericht/Objekt/Adresse/Beschreibung', () => {
    const items = [
      makeAuction({ zvgId: '1', beschreibung: 'Schöne Aussicht auf den See' }),
      makeAuction({ zvgId: '2', beschreibung: 'Ruhige Lage' }),
    ]
    const result = filterAuctions(items, { ...BASE_FILTERS, search: 'AUSSICHT' })
    expect(result.map((a) => a.zvgId)).toEqual(['1'])
  })

  it('trims the search term before matching', () => {
    const items = [makeAuction({ zvgId: '1', objekt: 'Einfamilienhaus' })]
    const result = filterAuctions(items, { ...BASE_FILTERS, search: '  einfamilienhaus  ' })
    expect(result.map((a) => a.zvgId)).toEqual(['1'])
  })

  it('combines country/region scoping with the rest of the filter pipeline', () => {
    const items = [
      makeAuction({ zvgId: '1', country: 'de', region: 'Bayern', verkehrswertEur: 500_000 }),
      makeAuction({ zvgId: '2', country: 'de', region: 'Sachsen', verkehrswertEur: 500_000 }),
      makeAuction({ zvgId: '3', country: 'es', region: 'Madrid', verkehrswertEur: 500_000 }),
    ]
    const result = filterAuctions(items, {
      ...BASE_FILTERS,
      countries: ['de'],
      regionNameKeys: new Set(['de:Sachsen']),
      priceMin: 100_000,
    })
    expect(result.map((a) => a.zvgId)).toEqual(['2'])
  })
})
