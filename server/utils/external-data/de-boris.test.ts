import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { buildBorisLandValueBaseline, type BorisLandValueZone } from './de-boris'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'zvg-portal',
    country: 'de',
    region: 'Berlin',
    externalId: '42',
    caseNumber: '1 K 1/26',
    authority: 'AG Test',
    title: 'Grundstueck',
    address: 'Berlin',
    marketValueEur: 300_000,
    marketValueText: '300.000 EUR',
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
    lat: 52.52,
    lng: 13.405,
    ...overrides,
  }
}

const zones: BorisLandValueZone[] = [
  { id: 'far', label: 'Far', lat: 53, lng: 13.4, valueEurPerSqm: 100, regionLabel: 'Brandenburg' },
  { id: 'near', label: 'Zone 1', lat: 52.5205, lng: 13.405, valueEurPerSqm: 850, regionLabel: 'Berlin' },
]

describe('buildBorisLandValueBaseline', () => {
  it('returns the nearest German land-value zone as a baseline', () => {
    const result = buildBorisLandValueBaseline(auction(), zones, {
      checkedAt: '2026-07-26T00:00:00.000Z',
    })

    expect(result).toMatchObject({
      valueEurPerSqm: 850,
      regionLabel: 'Berlin',
      zoneLabel: 'Zone 1',
      checkedAt: '2026-07-26T00:00:00.000Z',
      source: { id: 'de-boris-d' },
    })
    expect(result?.distanceMeters).toBeLessThan(100)
  })

  it('does not return a residential comparable for unsupported countries or distant zones', () => {
    expect(buildBorisLandValueBaseline(auction({ country: 'fr' }), zones)).toBeNull()
    expect(buildBorisLandValueBaseline(auction(), zones, { maxDistanceMeters: 1 })).toBeNull()
  })
})
