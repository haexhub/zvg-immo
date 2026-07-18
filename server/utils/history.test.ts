import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { auctionToObservationRow } from './history'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'de',
    region: 'Sachsen',
    externalId: '42',
    caseNumber: '1 K 1/26',
    authority: 'AG Test',
    title: 'Einfamilienhaus',
    address: null,
    marketValueEur: 250000,
    marketValueText: null,
    auctionDateIso: '2026-08-01T09:00:00.000Z',
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

describe('auctionToObservationRow', () => {
  it('maps the core auction fields to the observation row shape', () => {
    const row = auctionToObservationRow(auction(), '2026-07-17T00:00:00.000Z')
    expect(row).toEqual({
      captured_at: '2026-07-17T00:00:00.000Z',
      platform: 'test',
      country: 'de',
      region: 'Sachsen',
      external_id: '42',
      authority: 'AG Test',
      case_number: '1 K 1/26',
      title: 'Einfamilienhaus',
      property_type: null,
      land_area_sqm: null,
      living_area_sqm: null,
      rooms: null,
      units: null,
      market_value_eur: 250000,
      auction_date_iso: '2026-08-01T09:00:00.000Z',
      cancelled: false,
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
    const row = auctionToObservationRow(withExtraction, '2026-07-17T00:00:00.000Z')
    expect(row.property_type).toBe('einfamilienhaus')
    expect(row.land_area_sqm).toBe(500)
    expect(row.living_area_sqm).toBe(120)
    expect(row.rooms).toBe(4)
    expect(row.units).toBe(1)
  })

  it('leaves extracted fields null when no extraction is present', () => {
    const row = auctionToObservationRow(auction(), '2026-07-17T00:00:00.000Z')
    expect(row.property_type).toBeNull()
    expect(row.land_area_sqm).toBeNull()
    expect(row.living_area_sqm).toBeNull()
    expect(row.rooms).toBeNull()
    expect(row.units).toBeNull()
  })
})
