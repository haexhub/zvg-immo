import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { buildDvfMarketComparison, normalizeDvfRow, type DvfTransaction } from './fr-dvf'

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

describe('normalizeDvfRow', () => {
  it('parses French decimal commas and maps local types', () => {
    expect(normalizeDvfRow({
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
    })).toMatchObject({
      id: 'm1',
      priceEur: 250000.5,
      builtAreaSqm: 125.5,
      landAreaSqm: 300,
      propertyClass: 'house',
    })
  })

  it('drops rows without price or coordinates', () => {
    expect(normalizeDvfRow({ valeur_fonciere: '0', latitude: '48', longitude: '2' })).toBeNull()
    expect(normalizeDvfRow({ valeur_fonciere: '100000', latitude: null, longitude: '2' })).toBeNull()
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
