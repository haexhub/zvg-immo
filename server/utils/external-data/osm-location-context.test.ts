import { describe, expect, it, vi } from 'vitest'
import { buildLocationContext, createOsmLocationContextAdapter } from './osm-location-context'
import type { Auction } from '~/types/auction'

/** Latitude span of the bbox on the sub-query line ending in `marker`, so radius
 *  relationships can be asserted without restating the projection maths. */
function bboxWidthDeg(query: string, marker: string): number {
  const line = query.split('\n').find((candidate) => candidate.includes(marker))
  if (!line) throw new Error(`no sub-query for ${marker}`)
  const coords = line.match(/\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/)
  if (!coords) throw new Error(`no bbox for ${marker}`)
  return Number(coords[3]) - Number(coords[1])
}

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
      { type: 'node', id: 18, lat: 52.02, lon: 13.02, tags: { aeroway: 'aerodrome', name: 'Flugplatz Musterstadt' } },
      { type: 'way', id: 19, center: { lat: 52.018, lon: 13.018 }, tags: { aeroway: 'runway', ref: '08/26' } },
      { type: 'node', id: 20, lat: 52.0014, lon: 13.0014, tags: { aeroway: 'helipad', name: 'Kliniklandeplatz' } },
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
    expect(context.environment.heavyIndustrySites).toContainEqual({ kind: 'industrial_factory', name: 'Werk', distanceMeters: expect.any(Number) })
    expect(context.environment.noisyRoadLevel).toBe('medium')
    expect(context.environment.aviationNoiseLevel).toBe('high')
    expect(context.environment.nearestAirportName).toBe('Flugplatz Musterstadt')
    expect(context.environment.nearestAirportKind).toBe('minor')
    expect(context.environment.riskSignals).toContain('runway_very_near')
    expect(context.environment.riskSignals).toContain('airport_near')
    expect(context.environment.riskSignals).toContain('helipad_near')
    expect(context.demographics.youthSignal).toBe('high')
    expect(context.demographics.reasons).toContain('university_nearby')
    expect(context.mapFeatures.some((feature) => feature.kind === 'industry')).toBe(true)
    expect(context.mapFeatures.some((feature) => feature.kind === 'commercial')).toBe(true)
    expect(context.mapFeatures.some((feature) => feature.kind === 'airport')).toBe(true)
    expect(context.mapFeatures.some((feature) => feature.kind === 'runway')).toBe(true)
    expect(context.mapFeatures.some((feature) => feature.kind === 'helipad')).toBe(true)
    expect(context.mapFeatures.some((feature) => feature.kind === 'hospital')).toBe(true)
    expect(context.mapFeatures.some((feature) => feature.kind === 'restaurant')).toBe(true)
    expect(context.mapFeatures.some((feature) => feature.kind === 'cafe')).toBe(true)
    expect(context.neighborhood.vacantOrRuinCountWithin500m).toBe(1)
    expect(context.neighborhood.notes).toContainEqual({ code: 'building_count_500m', params: { count: 2 } })
  })

  // A bbox reaches ~1.41x its radius at the corners, so signals that assert
  // existence rather than a distance have to clip or they widen silently.
  it('ignores heavy industry beyond its radius that only the bbox corner picked up', () => {
    const inside = buildLocationContext({ lat: 52, lng: 13 }, [
      { type: 'way', id: 1, center: { lat: 52.03, lon: 13 }, tags: { power: 'plant', name: 'Kraftwerk' } },
    ], '2026-07-26T00:00:00.000Z')
    // Diagonally ~6.1 km out: past the 5 km radius, still within the bbox the
    // 5 km sub-queries send (north edge +0.0449 deg, east edge +0.0729 deg).
    const corner = buildLocationContext({ lat: 52, lng: 13 }, [
      { type: 'way', id: 1, center: { lat: 52.04, lon: 13.06 }, tags: { power: 'plant', name: 'Kraftwerk' } },
    ], '2026-07-26T00:00:00.000Z')

    expect(inside.environment.riskSignals).toContain('heavy_industry_mapped')
    expect(corner.environment.riskSignals).not.toContain('heavy_industry_mapped')
    expect(corner.environment.nearestHeavyIndustryDistanceMeters).toBeNull()
  })

  it('names the specific power plant type and airport class instead of a generic label', () => {
    const context = buildLocationContext({ lat: 52, lng: 13 }, [
      { type: 'way', id: 1, center: { lat: 52.01, lon: 13 }, tags: { power: 'plant', 'plant:source': 'nuclear', name: 'Kernkraftwerk Musterstadt' } },
      { type: 'way', id: 2, center: { lat: 52.02, lon: 13.02 }, tags: { man_made: 'petroleum_well', name: 'Bohrturm 3' } },
      { type: 'node', id: 3, lat: 52.05, lon: 13.05, tags: { aeroway: 'aerodrome', name: 'Flughafen Musterstadt', iata: 'MST', 'aerodrome:type': 'international' } },
    ], '2026-07-26T00:00:00.000Z')

    expect(context.environment.heavyIndustrySites).toContainEqual({ kind: 'power_plant_nuclear', name: 'Kernkraftwerk Musterstadt', distanceMeters: expect.any(Number) })
    expect(context.environment.heavyIndustrySites).toContainEqual({ kind: 'man_made_petroleum_well', name: 'Bohrturm 3', distanceMeters: expect.any(Number) })
    expect(context.environment.nearestHeavyIndustryDistanceMeters).not.toBeNull()
    expect(context.environment.nearestAirportName).toBe('Flughafen Musterstadt')
    expect(context.environment.nearestAirportKind).toBe('major')
  })

  it('classifies an unmarked small airfield as minor and a military one as military', () => {
    const minor = buildLocationContext({ lat: 52, lng: 13 }, [
      { type: 'node', id: 1, lat: 52.05, lon: 13.05, tags: { aeroway: 'aerodrome', name: 'Segelflugplatz' } },
    ], '2026-07-26T00:00:00.000Z')
    const military = buildLocationContext({ lat: 52, lng: 13 }, [
      { type: 'node', id: 1, lat: 52.05, lon: 13.05, tags: { aeroway: 'aerodrome', name: 'Fliegerhorst', military: 'airfield' } },
    ], '2026-07-26T00:00:00.000Z')

    expect(minor.environment.nearestAirportKind).toBe('minor')
    expect(military.environment.nearestAirportKind).toBe('military')
  })

  it('ignores a ferry route beyond its radius that only the bbox corner picked up', () => {
    // Diagonally ~12.1 km out: past the 10 km radius, still within the bbox the
    // ferry sub-queries send (north edge +0.0898 deg, east edge +0.1459 deg).
    const context = buildLocationContext({ lat: 52, lng: 13 }, [
      { type: 'way', id: 1, center: { lat: 52.08, lon: 13.12 }, tags: { route: 'ferry', name: 'Faehre' } },
      { type: 'node', id: 2, lat: 52.08, lon: 13.12, tags: { amenity: 'ferry_terminal', name: 'Faehrhafen' } },
    ], '2026-07-26T00:00:00.000Z')

    expect(context.mobility.hasFerryRouteNearby).toBe(false)
    expect(context.mobility.nearestFerryTerminalDistanceMeters).toBeNull()
    expect(context.mobility.ferryAccessLikely).toBe(false)
  })

  it('keeps local road access reachable for larger roads outside the regional cutoff', () => {
    const context = buildLocationContext({ lat: 52, lng: 13 }, [
      { type: 'way', id: 1, center: { lat: 52.0585, lon: 13 }, tags: { highway: 'secondary', name: 'L 42' } },
    ], '2026-07-26T00:00:00.000Z')

    expect(context.mobility.roadAccessLevel).toBe('local')
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
    const query = (request.body as URLSearchParams).get('data')
    expect(query).toContain('[out:json][timeout:120]')
    // 30 km of latitude either side of the point => ~0.539 deg of span
    expect(bboxWidthDeg(query ?? '', '["place"')).toBeCloseTo((2 * 30_000) / 111_320, 3)
    expect(context?.nearbyPlaces[0]?.name).toBe('Berlin')
  })

  it('uses the configured client timeout in the Overpass query timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ elements: [] }), { status: 200 }))
    const adapter = createOsmLocationContextAdapter({
      endpoint: 'https://overpass.example.test/api/interpreter',
      checkedAt: '2026-07-26T00:00:00.000Z',
      timeoutMs: 12_000,
      fetchImpl,
    })

    await adapter.context(auction())

    const request = fetchImpl.mock.calls[0]?.[1]
    if (!request) throw new Error('missing fetch request options')
    expect((request.body as URLSearchParams).get('data')).toContain('[out:json][timeout:12]')
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

  it('narrows the sub-queries that overloaded the public endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ elements: [] }), { status: 200 }))
    const adapter = createOsmLocationContextAdapter({
      endpoint: 'https://overpass.example.test/api/interpreter',
      checkedAt: '2026-07-26T00:00:00.000Z',
      fetchImpl,
    })

    await adapter.context(auction())
    const query = (fetchImpl.mock.calls[0]?.[1]?.body as URLSearchParams).get('data') ?? ''

    // bbox selection throughout: `around:` forces a linear scan and made the
    // query unable to finish inside any sane timeout.
    expect(query).not.toContain('around:')
    // places as nodes only — the nwr variant dragged in boundary relations
    expect(query).toMatch(/node\([\d.,-]+\)\["place"/)
    expect(query).not.toMatch(/nwr\([\d.,-]+\)\["place"/)
    // noise-relevant classes keep their range, minor classes shrink to 5 km
    expect(query).toContain('["highway"~"^(motorway|trunk|primary)$"]')
    expect(query).toContain('["highway"~"^(secondary|tertiary)$"]')
    expect(bboxWidthDeg(query, '["highway"~"^(motorway|trunk|primary)$"]'))
      .toBeGreaterThan(bboxWidthDeg(query, '["highway"~"^(secondary|tertiary)$"]'))
    // the unbounded office key no longer spans 5 km
    expect(bboxWidthDeg(query, '["office"]'))
      .toBeLessThan(bboxWidthDeg(query, '["industrial"]'))
  })

  describe('throttling and retry', () => {
    function okResponse(): Response {
      return new Response(JSON.stringify({ elements: [] }), { status: 200 })
    }

    it('retries a 429 instead of losing the auction', async () => {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
        .mockResolvedValueOnce(okResponse())
      const sleepImpl = vi.fn(async () => undefined)
      const adapter = createOsmLocationContextAdapter({
        endpoint: 'https://overpass.example.test/api/interpreter',
        checkedAt: '2026-07-26T00:00:00.000Z',
        fetchImpl,
        sleepImpl,
      })

      const context = await adapter.context(auction())

      expect(context).not.toBeNull()
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it.each([[504], [502], [503]])('retries a transient %i', async (status) => {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('busy', { status }))
        .mockResolvedValueOnce(okResponse())
      const adapter = createOsmLocationContextAdapter({
        endpoint: 'https://overpass.example.test/api/interpreter',
        checkedAt: '2026-07-26T00:00:00.000Z',
        fetchImpl,
        sleepImpl: async () => undefined,
      })

      await expect(adapter.context(auction())).resolves.not.toBeNull()
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it('retries a network-level failure', async () => {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(okResponse())
      const adapter = createOsmLocationContextAdapter({
        endpoint: 'https://overpass.example.test/api/interpreter',
        checkedAt: '2026-07-26T00:00:00.000Z',
        fetchImpl,
        sleepImpl: async () => undefined,
      })

      await expect(adapter.context(auction())).resolves.not.toBeNull()
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it('honours Retry-After over its own backoff', async () => {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '7' } }))
        .mockResolvedValueOnce(okResponse())
      const sleepImpl = vi.fn(async () => undefined)
      const adapter = createOsmLocationContextAdapter({
        endpoint: 'https://overpass.example.test/api/interpreter',
        checkedAt: '2026-07-26T00:00:00.000Z',
        fetchImpl,
        minRequestIntervalMs: 0,
        sleepImpl,
      })

      await adapter.context(auction())

      expect(sleepImpl).toHaveBeenCalledWith(7_000)
    })

    it('retries a died query reported as 200 with a remark', async () => {
      // An overloaded instance answers 200 + remark instead of 504, which would
      // otherwise be stored as a successful enrichment with no elements.
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          elements: [],
          remark: 'runtime error: Query timed out in "query" at line 5 after 120 seconds.',
        }), { status: 200 }))
        .mockResolvedValueOnce(okResponse())
      const adapter = createOsmLocationContextAdapter({
        endpoint: 'https://overpass.example.test/api/interpreter',
        checkedAt: '2026-07-26T00:00:00.000Z',
        fetchImpl,
        sleepImpl: async () => undefined,
      })

      await expect(adapter.context(auction())).resolves.not.toBeNull()
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it('surfaces a persistent remark as a failure rather than an empty context', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        elements: [],
        remark: 'runtime error: Query ran out of memory in "recurse" at line 8.',
      }), { status: 200 }))
      const adapter = createOsmLocationContextAdapter({
        endpoint: 'https://overpass.example.test/api/interpreter',
        checkedAt: '2026-07-26T00:00:00.000Z',
        fetchImpl,
        maxAttempts: 2,
        sleepImpl: async () => undefined,
      })

      await expect(adapter.context(auction())).rejects.toThrow('Overpass runtime error')
    })

    it('keeps a response whose remark is not an error', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        elements: [],
        remark: 'improve your query',
      }), { status: 200 }))
      const adapter = createOsmLocationContextAdapter({
        endpoint: 'https://overpass.example.test/api/interpreter',
        checkedAt: '2026-07-26T00:00:00.000Z',
        fetchImpl,
        sleepImpl: async () => undefined,
      })

      await expect(adapter.context(auction())).resolves.not.toBeNull()
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('does not retry a client error it cannot recover from', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response('bad query', { status: 400 }))
      const adapter = createOsmLocationContextAdapter({
        endpoint: 'https://overpass.example.test/api/interpreter',
        checkedAt: '2026-07-26T00:00:00.000Z',
        fetchImpl,
        sleepImpl: async () => undefined,
      })

      await expect(adapter.context(auction())).rejects.toThrow('Overpass returned 400')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('gives up after the attempt budget and surfaces the last error', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response('rate limited', { status: 429 }))
      const adapter = createOsmLocationContextAdapter({
        endpoint: 'https://overpass.example.test/api/interpreter',
        checkedAt: '2026-07-26T00:00:00.000Z',
        fetchImpl,
        maxAttempts: 3,
        sleepImpl: async () => undefined,
      })

      await expect(adapter.context(auction())).rejects.toThrow('Overpass returned 429')
      expect(fetchImpl).toHaveBeenCalledTimes(3)
    })

    it('stops hitting an endpoint that refuses every auction', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response('rate limited', { status: 429 }))
      const adapter = createOsmLocationContextAdapter({
        endpoint: 'https://overpass.example.test/api/interpreter',
        checkedAt: '2026-07-26T00:00:00.000Z',
        fetchImpl,
        maxAttempts: 2,
        giveUpAfterConsecutiveFailures: 2,
        sleepImpl: async () => undefined,
      })

      await expect(adapter.context(auction({ externalId: '1' }))).rejects.toThrow('Overpass returned 429')
      await expect(adapter.context(auction({ externalId: '2' }))).rejects.toThrow('Overpass returned 429')
      expect(fetchImpl).toHaveBeenCalledTimes(4)

      // Budget spent: further auctions fail without touching the network.
      await expect(adapter.context(auction({ externalId: '3' }))).rejects.toThrow('Overpass unavailable')
      expect(fetchImpl).toHaveBeenCalledTimes(4)
    })

    it('resets the give-up counter after a success', async () => {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
        .mockResolvedValueOnce(okResponse())
        .mockResolvedValue(new Response('rate limited', { status: 429 }))
      const adapter = createOsmLocationContextAdapter({
        endpoint: 'https://overpass.example.test/api/interpreter',
        checkedAt: '2026-07-26T00:00:00.000Z',
        fetchImpl,
        maxAttempts: 1,
        giveUpAfterConsecutiveFailures: 2,
        sleepImpl: async () => undefined,
      })

      await expect(adapter.context(auction({ externalId: '1' }))).rejects.toThrow('Overpass returned 429')
      await expect(adapter.context(auction({ externalId: '2' }))).resolves.not.toBeNull()
      // Counter cleared, so the next two failures are attempted rather than skipped.
      await expect(adapter.context(auction({ externalId: '3' }))).rejects.toThrow('Overpass returned 429')
      await expect(adapter.context(auction({ externalId: '4' }))).rejects.toThrow('Overpass returned 429')
      await expect(adapter.context(auction({ externalId: '5' }))).rejects.toThrow('Overpass unavailable')
    })

    it('probes again once the give-up cooldown elapses, instead of skipping the rest of the run', async () => {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
        .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
        .mockResolvedValueOnce(okResponse())
      let clock = 0
      const adapter = createOsmLocationContextAdapter({
        endpoint: 'https://overpass.example.test/api/interpreter',
        checkedAt: '2026-07-26T00:00:00.000Z',
        fetchImpl,
        maxAttempts: 1,
        giveUpAfterConsecutiveFailures: 2,
        giveUpCooldownMs: 60_000,
        sleepImpl: async () => undefined,
        nowImpl: () => clock,
      })

      await expect(adapter.context(auction({ externalId: '1' }))).rejects.toThrow('Overpass returned 429')
      await expect(adapter.context(auction({ externalId: '2' }))).rejects.toThrow('Overpass returned 429')
      // Cooldown just tripped: the next auction is skipped without touching the network.
      await expect(adapter.context(auction({ externalId: '3' }))).rejects.toThrow('Overpass unavailable')
      expect(fetchImpl).toHaveBeenCalledTimes(2)

      clock += 60_000
      // Cooldown elapsed: this auction — further along in the same run — gets a real attempt.
      await expect(adapter.context(auction({ externalId: '4' }))).resolves.not.toBeNull()
      expect(fetchImpl).toHaveBeenCalledTimes(3)
    })

    it('spaces consecutive auctions by the configured interval', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => okResponse())
      const waits: number[] = []
      const adapter = createOsmLocationContextAdapter({
        endpoint: 'https://overpass.example.test/api/interpreter',
        checkedAt: '2026-07-26T00:00:00.000Z',
        fetchImpl,
        minRequestIntervalMs: 2_000,
        sleepImpl: async (ms) => { waits.push(ms) },
      })

      await adapter.context(auction())
      await adapter.context(auction({ externalId: '43' }))

      // First call goes straight through; the second is held back.
      expect(waits).toHaveLength(1)
      expect(waits[0]).toBeGreaterThan(0)
      expect(waits[0]).toBeLessThanOrEqual(2_000)
    })
  })
})
