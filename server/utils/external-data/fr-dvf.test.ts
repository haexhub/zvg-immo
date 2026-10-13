import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { buildDvfMarketComparison, normalizeDvfMutation, type DvfTransaction } from './fr-dvf'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'fr-test',
    country: 'fr',
    region: 'Ile-de-France',
    externalId: '42',
    caseNumber: 'FR-42',
    authority: 'Tribunal judiciaire',
    title: 'Maison',
    address: 'Paris',
    marketValueEur: 400_000,
    marketValueText: '400 000 EUR',
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
    lat: 48.8566,
    lng: 2.3522,
    extraction: {
      propertyType: 'einfamilienhaus',
      landAreaSqm: 300,
      livingAreaSqm: 100,
      rooms: null,
      units: null,
      source: 'rules',
      confidence: 'high',
      at: '2026-07-26T00:00:00.000Z',
    },
    ...overrides,
  }
}

function tx(priceEur: number, builtAreaSqm: number, overrides: Partial<DvfTransaction> = {}): DvfTransaction {
  return {
    id: String(priceEur),
    date: '2025-01-01',
    lat: 48.8566,
    lng: 2.3522,
    communeCode: '75056',
    communeName: 'Paris',
    propertyClass: 'house',
    priceEur,
    builtAreaSqm,
    landAreaSqm: 300,
    ...overrides,
  }
}

describe('normalizeDvfMutation', () => {
  it('parses French decimal commas and maps local types', () => {
    expect(normalizeDvfMutation([{
      id_mutation: 'm1',
      date_mutation: '2025-01-01',
      valeur_fonciere: '250000,50',
      code_commune: '75056',
      commune: 'Paris',
      type_local: 'Maison',
      surface_reelle_bati: '125,5',
      surface_terrain: '300',
      latitude: '48,8566',
      longitude: '2,3522',
    }])).toMatchObject({
      id: 'm1',
      priceEur: 250000.5,
      builtAreaSqm: 125.5,
      landAreaSqm: 300,
      propertyClass: 'house',
    })
  })

  it('drops rows without price or coordinates', () => {
    expect(normalizeDvfMutation([{ valeur_fonciere: '0', type_local: 'Maison', latitude: '48', longitude: '2' }])).toBeNull()
    expect(normalizeDvfMutation([{ valeur_fonciere: '100000', type_local: 'Maison', latitude: null, longitude: '2' }])).toBeNull()
  })

  it('counts a multi-row mutation once, with its price over the summed distinct areas', () => {
    const base = {
      id_mutation: 'm1',
      valeur_fonciere: '2400000',
      type_local: 'Appartement',
      surface_reelle_bati: '50',
      id_parcelle: '75056000AB0001',
      surface_terrain: '800',
      nature_culture: 'sols',
      latitude: '48,8566',
      longitude: '2,3522',
    }
    const rows = Array.from({ length: 12 }, (_, i) => ({ ...base, lot1_numero: String(i + 1) }))
    // A cellar sold with the flats adds neither a class nor living area.
    rows.push({ ...base, lot1_numero: '13', type_local: 'Dépendance', surface_reelle_bati: '' })

    expect(normalizeDvfMutation(rows)).toMatchObject({
      id: 'm1',
      propertyClass: 'apartment',
      priceEur: 2_400_000,
      builtAreaSqm: 600,
      landAreaSqm: 800,
    })
  })

  it('classifies a sale without any local but with a land use as land', () => {
    const land = { id_mutation: 'm1', valeur_fonciere: '90000', type_local: '', latitude: '48', longitude: '2' }
    expect(normalizeDvfMutation([
      { ...land, id_parcelle: 'p1', nature_culture: 'terrains a bâtir', surface_terrain: '600' },
      { ...land, id_parcelle: 'p2', nature_culture: 'terres', surface_terrain: '400' },
    ])).toMatchObject({ propertyClass: 'land', builtAreaSqm: null, landAreaSqm: 1000 })
    // A garage sold on its own is neither a home nor land.
    expect(normalizeDvfMutation([
      { ...land, type_local: 'Dépendance', id_parcelle: 'p1', nature_culture: 'sols', surface_terrain: '50' },
    ])).toBeNull()
  })

  it('drops mutations mixing local types', () => {
    expect(normalizeDvfMutation([
      { id_mutation: 'm1', valeur_fonciere: '500000', type_local: 'Maison', surface_reelle_bati: '100', latitude: '48', longitude: '2' },
      { id_mutation: 'm1', valeur_fonciere: '500000', type_local: 'Appartement', surface_reelle_bati: '40', latitude: '48', longitude: '2' },
    ])).toBeNull()
  })
})

describe('buildDvfMarketComparison', () => {
  it('computes percentiles and verdict from nearby same-class transactions', () => {
    const transactions = [
      tx(450_000, 100), tx(460_000, 100), tx(470_000, 100), tx(480_000, 100),
      tx(490_000, 100), tx(500_000, 100), tx(510_000, 100), tx(520_000, 100),
      tx(530_000, 100), tx(540_000, 100), tx(550_000, 100),
      tx(900_000, 100, { propertyClass: 'apartment' }),
      tx(200_000, 100, { lat: 45, lng: 4 }),
    ]

    const result = buildDvfMarketComparison(auction(), transactions)

    expect(result?.samples).toBe(11)
    expect(result?.medianPricePerSqm).toBe(5000)
    expect(result?.p25PricePerSqm).toBe(4750)
    expect(result?.p75PricePerSqm).toBe(5250)
    expect(result?.deltaPctVsMedian).toBe(-20)
    expect(result?.verdict).toBe('cheaper')
    expect(result?.sources[0]?.id).toBe('fr-dvf-geolocated')
  })

  it('returns insufficient_data below the minimum sample count', () => {
    const result = buildDvfMarketComparison(auction(), [tx(500_000, 100)], { minSamples: 2 })

    expect(result?.samples).toBe(1)
    expect(result?.verdict).toBe('insufficient_data')
    expect(result?.medianPricePerSqm).toBeNull()
  })

  it('does not compare non-French or ungeocoded auctions', () => {
    expect(buildDvfMarketComparison(auction({ country: 'de' }), [tx(500_000, 100)])).toBeNull()
    expect(buildDvfMarketComparison(auction({ lat: null }), [tx(500_000, 100)])).toBeNull()
  })
})
