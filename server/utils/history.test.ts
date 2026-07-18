import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { auctionToObservationRow } from './history'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'de',
    region: 'Sachsen',
    zvgId: '42',
    aktenzeichen: '1 K 1/26',
    amtsgericht: 'AG Test',
    objekt: 'Einfamilienhaus',
    adresse: null,
    verkehrswertEur: 250000,
    verkehrswertText: null,
    terminIso: '2026-08-01T09:00:00.000Z',
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

describe('auctionToObservationRow', () => {
  it('maps the core auction fields to the observation row shape', () => {
    const row = auctionToObservationRow(auction(), '2026-07-17T00:00:00.000Z')
    expect(row).toEqual({
      captured_at: '2026-07-17T00:00:00.000Z',
      platform: 'test',
      country: 'de',
      region: 'Sachsen',
      zvg_id: '42',
      amtsgericht: 'AG Test',
      aktenzeichen: '1 K 1/26',
      objekt: 'Einfamilienhaus',
      property_type: null,
      land_area_sqm: null,
      living_area_sqm: null,
      rooms: null,
      units: null,
      verkehrswert_eur: 250000,
      termin_iso: '2026-08-01T09:00:00.000Z',
      aufgehoben: false,
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
