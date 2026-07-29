import { describe, expect, it, vi } from 'vitest'
import { buildLocationContext, createOsmLocationContextAdapter } from './osm-location-context'
import type { Auction } from '~/types/auction'

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'de',
    region: 'Bayern',
    externalId: '42',
    caseNumber: 'K 42',
    authority: 'Amtsgericht',
    title: 'Haus',
    address: 'Musterstrasse 1',
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
    lat: 52,
    lng: 13,
    ...overrides,
  }
}

describe('buildLocationContext', () => {
  it('derives nearby places, access and neighborhood signals from OSM elements', () => {
    const context = buildLocationContext({ lat: 52, lng: 13 }, [
      { type: 'node', id: 1, lat: 52.01, lon: 13.01, tags: { place: 'town', name: 'Musterstadt', population: '25000' } },
      { type: 'node', id: 2, lat: 52.001, lon: 13.001, tags: { highway: 'bus_stop', name: 'Am Markt' } },
      { type: 'node', id: 3, lat: 52.002, lon: 13.002, tags: { railway: 'station', name: 'Musterstadt Bahnhof' } },
      { type: 'way', id: 4, center: { lat: 52.003, lon: 13.003 }, tags: { highway: 'primary', name: 'B 1' } },
      { type: 'way', id: 5, center: { lat: 52.0005, lon: 13.0005 }, tags: { building: 'house' } },
      { type: 'node', id: 6, lat: 52.0006, lon: 13.0006, tags: { amenity: 'school' } },
      { type: 'way', id: 7, center: { lat: 52.0007, lon: 13.0007 }, tags: { building: 'ruins' } },
      { type: 'node', id: 8, lat: 52.0008, lon: 13.0008, tags: { shop: 'supermarket' } },
      { type: 'node', id: 9, lat: 52.0009, lon: 13.0009, tags: { amenity: 'doctors' } },
      { type: 'node', id: 14, lat: 52.001, lon: 13.001, tags: { amenity: 'hospital', name: 'Klinik' } },
      { type: 'node', id: 15, lat: 52.0011, lon: 13.0011, tags: { amenity: 'restaurant', name: 'Restaurant' } },
      { type: 'node', id: 16, lat: 52.0012, lon: 13.0012, tags: { amenity: 'cafe', name: 'Cafe' } },
      { type: 'node', id: 17, lat: 52.0013, lon: 13.0013, tags: { leisure: 'park', name: 'Park' } },
      { type: 'way', id: 10, center: { lat: 52.004, lon: 13.004 }, tags: { landuse: 'industrial', name: 'Gewerbepark' } },
      { type: 'way', id: 11, center: { lat: 52.005, lon: 13.005 }, tags: { man_made: 'works', industrial: 'factory', name: 'Werk' } },
      { type: 'node', id: 12, lat: 52.006, lon: 13.006, tags: { amenity: 'university', name: 'Uni' } },
      { type: 'way', id: 13, center: { lat: 52.007, lon: 13.007 }, tags: { landuse: 'commercial', name: 'Bueropark' } },
    ], '2026-07-26T00:00:00.000Z')

    expect(context.nearbyPlaces[0]).toMatchObject({
      name: 'Musterstadt',
      kind: 'town',
      population: 25_000,
    })
    expect(context.mobility.publicTransportLevel).toBe('excellent')
    expect(context.mobility.roadAccessLevel).toBe('major')
    expect(context.amenities.find((item) => item.kind === 'groceries')).toMatchObject({
      countWithin1000m: 1,
    })
    expect(context.amenities.find((item) => item.kind === 'hospital')).toMatchObject({
      countWithin1000m: 1,
    })
    expect(context.amenities.find((item) => item.kind === 'restaurant')).toMatchObject({
      countWithin1000m: 1,
    })
    expect(context.amenities.find((item) => item.kind === 'cafe')).toMatchObject({
      countWithin1000m: 1,
    })
    expect(context.amenities.find((item) => item.kind === 'food')).toMatchObject({
      countWithin1000m: 2,
    })
    expect(context.amenities.find((item) => item.kind === 'recreation')).toMatchObject({
      countWithin1000m: 1,
    })
    expect(context.quality.score).toBeGreaterThan(50)
    expect(context.quality.strengths).toContain('groceries_nearby')
    expect(context.environment.heavyIndustryKinds).toContain('factory')
    expect(context.environment.noisyRoadLevel).toBe('medium')
    expect(context.demographics.youthSignal).toBe('high')
    expect(context.demographics.reasons).toContain('university_nearby')
    expect(context.mapFeatures.some((feature) => feature.kind === 'industry')).toBe(true)
    expect(context.mapFeatures.some((feature) => feature.kind === 'commercial')).toBe(true)
    expect(context.mapFeatures.some((feature) => feature.kind === 'hospital')).toBe(true)
    expect(context.mapFeatures.some((feature) => feature.kind === 'restaurant')).toBe(true)
    expect(context.mapFeatures.some((feature) => feature.kind === 'cafe')).toBe(true)
    expect(context.neighborhood.vacantOrRuinCountWithin500m).toBe(1)
    expect(context.neighborhood.notes).toContain('2 OSM-Gebaeude im 500-m-Umfeld')
  })
})

describe('createOsmLocationContextAdapter', () => {
  it('posts a bounded Overpass query and parses the response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      elements: [
        { type: 'node', id: 1, lat: 52.01, lon: 13.01, tags: { place: 'city', name: 'Berlin' } },
      ],
    }), { status: 200 }))
    const adapter = createOsmLocationContextAdapter({
      endpoint: 'https://overpass.example.test/api/interpreter',
      checkedAt: '2026-07-26T00:00:00.000Z',
      fetchImpl,
    })

    const context = await adapter.context(auction())

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://overpass.example.test/api/interpreter',
      expect.objectContaining({ method: 'POST' }),
    )
    const request = fetchImpl.mock.calls[0]?.[1]
    if (!request) throw new Error('missing fetch request options')
    expect((request.body as URLSearchParams).get('data')).toContain('around:30000,52.000000,13.000000')
    expect(context?.nearbyPlaces[0]?.name).toBe('Berlin')
  })

  it('stays unsupported without endpoint or coordinates', () => {
    const withEndpoint = createOsmLocationContextAdapter({
      endpoint: 'https://overpass.example.test/api/interpreter',
      checkedAt: '2026-07-26T00:00:00.000Z',
    })
    const withoutEndpoint = createOsmLocationContextAdapter({
      endpoint: '',
      checkedAt: '2026-07-26T00:00:00.000Z',
    })

    expect(withEndpoint.supports(auction({ lat: null, lng: null }))).toBe(false)
    expect(withoutEndpoint.supports(auction())).toBe(false)
  })
})
