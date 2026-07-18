import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { toPublicAuction, toPublicObservation } from './data-api-shape'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'de-by',
    country: 'de',
    region: 'Bayern',
    externalId: '42',
    caseNumber: '1 K 1/26',
    authority: 'AG Test',
    title: 'Einfamilienhaus',
    address: 'Musterstraße 1',
    marketValueEur: 250000,
    marketValueText: null,
    auctionDateIso: '2026-08-01T09:00:00.000Z',
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: '2026-07-01T00:00:00.000Z',
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    description: null,
    photoCount: 3,
    thumbnailUrl: null,
    ...overrides,
  }
}

describe('toPublicAuction', () => {
  it('maps the internal Auction shape to the stable public contract', () => {
    expect(toPublicAuction(auction())).toEqual({
      platform: 'de-by',
      country: 'de',
      region: 'Bayern',
      id: '42',
      court: 'AG Test',
      caseNumber: '1 K 1/26',
      title: 'Einfamilienhaus',
      address: 'Musterstraße 1',
      marketValueEur: 250000,
      marketValue: null,
      currency: null,
      auctionDate: '2026-08-01T09:00:00.000Z',
      withdrawn: false,
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      units: null,
      photoCount: 3,
      lastUpdated: '2026-07-01T00:00:00.000Z',
      appUrl: '/objekt/de-by/42',
    })
  })

  it('pulls property type + sizes from extraction when present', () => {
    const withExtraction = auction({
      extraction: {
        propertyType: 'einfamilienhaus',
        landAreaSqm: 500,
        livingAreaSqm: 120,
        rooms: 4,
        units: 1,
        source: 'rules',
        confidence: 'high',
        at: '2026-07-17T00:00:00.000Z',
      },
    })
    const result = toPublicAuction(withExtraction)
    expect(result.propertyType).toBe('einfamilienhaus')
    expect(result.landAreaSqm).toBe(500)
    expect(result.livingAreaSqm).toBe(120)
    expect(result.rooms).toBe(4)
    expect(result.units).toBe(1)
  })

  it('percent-encodes platform/id in appUrl', () => {
    const result = toPublicAuction(auction({ platform: 'a b', externalId: 'c/d' }))
    expect(result.appUrl).toBe('/objekt/a%20b/c%2Fd')
  })

  it('carries marketValue/currency through when the crawler set them', () => {
    const result = toPublicAuction(auction({ marketValue: 6_500_000, currency: 'CZK' }))
    expect(result.marketValue).toBe(6_500_000)
    expect(result.currency).toBe('CZK')
  })
})

describe('toPublicObservation', () => {
  it('maps a raw pg row (numeric columns as strings) to the stable contract', () => {
    const row = {
      platform: 'de-by',
      country: 'de',
      region: 'Bayern',
      external_id: '42',
      authority: 'AG Test',
      case_number: '1 K 1/26',
      title: 'Einfamilienhaus',
      property_type: 'einfamilienhaus',
      land_area_sqm: '500',
      living_area_sqm: '120',
      rooms: '4',
      units: '1',
      market_value_eur: '250000',
      market_value: '6500000',
      currency: 'CZK',
      auction_date_iso: '2026-08-01T09:00:00.000Z',
      cancelled: false,
      captured_at: '2026-07-17T00:00:00.000Z',
    }
    expect(toPublicObservation(row)).toEqual({
      platform: 'de-by',
      country: 'de',
      region: 'Bayern',
      id: '42',
      court: 'AG Test',
      caseNumber: '1 K 1/26',
      title: 'Einfamilienhaus',
      propertyType: 'einfamilienhaus',
      landAreaSqm: 500,
      livingAreaSqm: 120,
      rooms: 4,
      units: 1,
      marketValueEur: 250000,
      marketValue: 6500000,
      currency: 'CZK',
      auctionDate: '2026-08-01T09:00:00.000Z',
      withdrawn: false,
      capturedAt: '2026-07-17T00:00:00.000Z',
    })
  })

  it('leaves nullable numeric/text fields null when the row has nulls', () => {
    const row = {
      platform: 'de-by',
      country: 'de',
      region: '',
      external_id: '1',
      authority: 'AG Test',
      case_number: '1 K 1/26',
      title: null,
      property_type: null,
      land_area_sqm: null,
      living_area_sqm: null,
      rooms: null,
      units: null,
      market_value_eur: null,
      market_value: null,
      currency: null,
      auction_date_iso: null,
      cancelled: true,
      captured_at: '2026-07-17T00:00:00.000Z',
    }
    const result = toPublicObservation(row)
    expect(result.title).toBeNull()
    expect(result.propertyType).toBeNull()
    expect(result.landAreaSqm).toBeNull()
    expect(result.livingAreaSqm).toBeNull()
    expect(result.rooms).toBeNull()
    expect(result.units).toBeNull()
    expect(result.marketValueEur).toBeNull()
    expect(result.marketValue).toBeNull()
    expect(result.currency).toBeNull()
    expect(result.auctionDate).toBeNull()
    expect(result.withdrawn).toBe(true)
  })
})
