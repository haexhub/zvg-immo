import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { createLocalOsmLocationContextAdapter } from './osm-location-context'
import { buildLocationContext } from './osm-location-context-builder'
import type { Auction } from '~/types/auction'
import { withStatementTimeout } from '~/server/utils/db'

// The fake pools below only implement query(); run each category on the pool
// itself instead of a checked-out client with SET LOCAL statement_timeout.
vi.mock('~/server/utils/db', () => ({
  withStatementTimeout: vi.fn((db: unknown, _timeoutMs: number, fn: (client: unknown) => unknown) => fn(db)),
}))

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
      { type: 'node', id: 3, lat: 52.002, lon: 13.002, tags: { railway: 'station', name: 'Musterstadt Bahnhof', network: 'DB Fernverkehr', ref: 'ICE 42' } },
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
    expect(context.mobility.regionalRailConnection).toBe('available')
    expect(context.mobility.regionalRailStationName).toBe('Musterstadt Bahnhof')
    expect(context.mobility.nationalRailConnection).toBe('available')
    expect(context.mobility.nationalRailStationName).toBe('Musterstadt Bahnhof')
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

  it('does not treat a tram stop or an untagged railway station as confirmed long-distance service', () => {
    const context = buildLocationContext({ lat: 52, lng: 13 }, [
      { type: 'node', id: 1, lat: 52.002, lon: 13, tags: { railway: 'tram_stop', name: 'Markt' } },
      { type: 'node', id: 2, lat: 52.01, lon: 13, tags: { railway: 'station', name: 'Regionalbahnhof' } },
    ], '2026-07-26T00:00:00.000Z')

    expect(context.mobility.regionalRailConnection).toBe('available')
    expect(context.mobility.regionalRailStationName).toBe('Regionalbahnhof')
    expect(context.mobility.nationalRailConnection).toBe('not_detected')
    expect(context.mobility.nationalRailStationName).toBeNull()
  })
})

interface LocalOsmRow {
  osm_type: 'node' | 'way' | 'relation'
  osm_id: string
  lat: number
  lon: number
  tags: Record<string, string>
}

/** Fakes the Pool `createLocalOsmLocationContextAdapter` queries: an
 *  EXISTS check per country, then one SELECT per tag category. Rows are
 *  looked up by `tagKey` + `values` (the same params queryCategory sends),
 *  not by parsing SQL, since the query text itself isn't under test here —
 *  that's exercised implicitly by getting the right rows back. */
function fakeOsmPool(options: {
  covered?: boolean
  rowsByTag?: Record<string, LocalOsmRow[]>
  longDistanceRouteStationRows?: LocalOsmRow[]
} = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const covered = options.covered ?? true
  const rowsByTag = options.rowsByTag ?? {}
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    if (sql.includes('SELECT EXISTS')) return { rows: [{ exists: covered }] }
    const tagKey = params[4] as string
    const values = params[5] as string[] | undefined
    const key = `${tagKey}:${values ? JSON.stringify(values) : ''}`
    if (sql.includes("immo:long_distance_train_route") && options.longDistanceRouteStationRows) {
      return { rows: options.longDistanceRouteStationRows }
    }
    return { rows: rowsByTag[key] ?? [] }
  }
  return { pool: { query } as unknown as Pool, calls }
}

describe('createLocalOsmLocationContextAdapter', () => {
  it('queries the local table and builds a context from the rows it finds', async () => {
    const { pool } = fakeOsmPool({
      rowsByTag: {
        'place:["city","town","suburb","village","hamlet","island","municipality"]': [
          { osm_type: 'node', osm_id: '1', lat: 52.01, lon: 13.01, tags: { place: 'city', name: 'Berlin' } },
        ],
      },
    })
    const adapter = createLocalOsmLocationContextAdapter({ db: pool, checkedAt: '2026-07-26T00:00:00.000Z' })

    const context = await adapter.context(auction())

    expect(context?.nearbyPlaces[0]?.name).toBe('Berlin')
  })

  it('scopes the query to the auction country and coordinates', async () => {
    const { pool, calls } = fakeOsmPool()
    const adapter = createLocalOsmLocationContextAdapter({ db: pool, checkedAt: '2026-07-26T00:00:00.000Z' })

    await adapter.context(auction({ country: 'DE', lat: 52, lng: 13 }))

    const categoryCall = calls.find((call) => !call.sql.includes('SELECT EXISTS'))
    if (!categoryCall) throw new Error('no category query issued')
    expect(categoryCall.params.slice(0, 3)).toEqual(['de', 13, 52])
  })

  it('restricts place and bus_stop lookups to nodes, so a boundary relation is not picked up as a place', async () => {
    const { pool, calls } = fakeOsmPool()
    const adapter = createLocalOsmLocationContextAdapter({ db: pool, checkedAt: '2026-07-26T00:00:00.000Z' })

    await adapter.context(auction())

    const placeCall = calls.find((call) => call.params[4] === 'place')
    const busStopCall = calls.find((call) => call.params[4] === 'highway' && (call.params[5] as string[])?.includes('bus_stop'))
    const buildingCall = calls.find((call) => call.params[4] === 'building' && call.params[5] === undefined)
    if (!placeCall || !busStopCall || !buildingCall) throw new Error('expected category query missing')
    expect(placeCall.sql).toContain("osm_type = 'node'")
    expect(busStopCall.sql).toContain("osm_type = 'node'")
    expect(buildingCall.sql).not.toContain("osm_type = 'node'")
  })

  it('dedupes an OSM object matched by more than one tag category', async () => {
    const shared: LocalOsmRow = { osm_type: 'way', osm_id: '99', lat: 52.001, lon: 13.001, tags: { building: 'yes', office: 'insurance' } }
    const { pool } = fakeOsmPool({
      rowsByTag: {
        'building:': [shared],
        'office:': [shared],
      },
    })
    const adapter = createLocalOsmLocationContextAdapter({ db: pool, checkedAt: '2026-07-26T00:00:00.000Z' })

    const context = await adapter.context(auction())

    expect(context?.neighborhood.notes).toContainEqual({ code: 'building_count_500m', params: { count: 1 } })
  })

  it('maps an explicitly tagged long-distance train route to its nearby station', async () => {
    const station: LocalOsmRow = {
      osm_type: 'node',
      osm_id: '42',
      lat: 52.01,
      lon: 13,
      // Simulates the station tags after queryCategory found a nearby
      // type=route + route=train + service=high_speed relation.
      tags: { railway: 'station', name: 'Fernbahnhof', 'immo:long_distance_train_route': 'yes' },
    }
    const { pool, calls } = fakeOsmPool({ longDistanceRouteStationRows: [station] })
    const adapter = createLocalOsmLocationContextAdapter({ db: pool, checkedAt: '2026-07-26T00:00:00.000Z' })

    const context = await adapter.context(auction())

    expect(context?.mobility.regionalRailConnection).toBe('available')
    expect(context?.mobility.nationalRailConnection).toBe('available')
    expect(context?.mobility.nationalRailStationName).toBe('Fernbahnhof')
    const railCall = calls.find((call) => call.params[4] === 'railway')
    expect(railCall?.sql).toContain("train_route.tags ->> 'type' = 'route'")
    expect(railCall?.sql).toContain("train_route.tags ->> 'route' = 'train'")
    expect(railCall?.sql).toContain("train_route.tags ->> 'service' IN ('long_distance', 'high_speed', 'national', 'international')")
  })

  it('returns null for a country with no imported data instead of an empty context', async () => {
    const { pool, calls } = fakeOsmPool({ covered: false })
    const adapter = createLocalOsmLocationContextAdapter({ db: pool, checkedAt: '2026-07-26T00:00:00.000Z' })

    const context = await adapter.context(auction())

    expect(context).toBeNull()
    // Skips every category query — only the coverage check ran.
    expect(calls).toHaveLength(1)
  })

  it('checks country coverage once per run, not once per auction', async () => {
    const { pool, calls } = fakeOsmPool()
    const adapter = createLocalOsmLocationContextAdapter({ db: pool, checkedAt: '2026-07-26T00:00:00.000Z' })

    await adapter.context(auction({ externalId: '1' }))
    await adapter.context(auction({ externalId: '2' }))

    expect(calls.filter((call) => call.sql.includes('SELECT EXISTS'))).toHaveLength(1)
  })

  it('runs at most four category queries at once, each under a server-side statement timeout', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const query = async (sql: string) => {
      if (sql.includes('SELECT EXISTS')) return { rows: [{ exists: true }] }
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      return { rows: [] }
    }
    const adapter = createLocalOsmLocationContextAdapter({ db: { query } as unknown as Pool, checkedAt: '2026-07-26T00:00:00.000Z' })

    await adapter.context(auction())

    expect(maxInFlight).toBe(4)
    expect(vi.mocked(withStatementTimeout)).toHaveBeenCalledWith(expect.anything(), 12_000, expect.any(Function))
  })

  it('asks for coverage again after a failed coverage check instead of failing the whole run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let coverageCalls = 0
    const query = async (sql: string) => {
      if (sql.includes('SELECT EXISTS')) {
        coverageCalls++
        if (coverageCalls === 1) throw new Error('coverage read timeout')
        return { rows: [{ exists: true }] }
      }
      return { rows: [] }
    }
    const adapter = createLocalOsmLocationContextAdapter({ db: { query } as unknown as Pool, checkedAt: '2026-07-26T00:00:00.000Z' })

    await expect(adapter.context(auction({ externalId: '1' }))).rejects.toThrow('coverage read timeout')
    await expect(adapter.context(auction({ externalId: '2' }))).resolves.not.toBeNull()
    expect(coverageCalls).toBe(2)
    warn.mockRestore()
  })

  it('stays unsupported without coordinates', () => {
    const { pool } = fakeOsmPool()
    const adapter = createLocalOsmLocationContextAdapter({ db: pool, checkedAt: '2026-07-26T00:00:00.000Z' })

    expect(adapter.supports(auction({ lat: null, lng: null }))).toBe(false)
    expect(adapter.supports(auction())).toBe(true)
  })
  describe('query timing log', () => {
    afterEach(() => vi.restoreAllMocks())

    it('names the failing category and starts no further queries once one times out', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const started: unknown[] = []
      let inFlight = 0
      const query = async (sql: string, params: unknown[] = []) => {
        if (sql.includes('SELECT EXISTS')) return { rows: [{ exists: true }] }
        started.push(params[4])
        if (params[4] === 'railway') throw new Error('canceling statement due to statement timeout')
        inFlight++
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight--
        return { rows: [] }
      }
      const adapter = createLocalOsmLocationContextAdapter({ db: { query } as unknown as Pool, checkedAt: '2026-07-26T00:00:00.000Z' })

      await expect(adapter.context(auction({ lat: 49.01, lng: 8.4 }))).rejects.toThrow('statement timeout')

      // The queries already running finished before the error surfaced, so a
      // failed context leaves nothing behind on the shared pool.
      expect(inFlight).toBe(0)
      expect(started.length).toBeLessThan(10)
      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0]?.[0])
      expect(line).toContain('[osm-context]')
      expect(line).toContain('at 49.01,8.4 failed (canceling statement due to statement timeout)')
      expect(line).toContain('failed: railway=station|halt|tram_stop@15000m')
    })

    it('logs a failed coverage check', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const query = async (sql: string) => {
        if (sql.includes('SELECT EXISTS')) throw new Error('coverage read timeout')
        return { rows: [] }
      }
      const adapter = createLocalOsmLocationContextAdapter({ db: { query } as unknown as Pool, checkedAt: '2026-07-26T00:00:00.000Z' })

      await expect(adapter.context(auction())).rejects.toThrow('coverage read timeout')

      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('failed (coverage read timeout)')
    })

    it('stays silent for a fast context', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { pool } = fakeOsmPool()
      const adapter = createLocalOsmLocationContextAdapter({ db: pool, checkedAt: '2026-07-26T00:00:00.000Z' })

      await adapter.context(auction())

      expect(warn).not.toHaveBeenCalled()
    })

    it('reports a slow but successful context with its slowest categories', async () => {
      vi.useFakeTimers()
      try {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const query = async (sql: string, params: unknown[] = []) => {
          if (sql.includes('SELECT EXISTS')) return { rows: [{ exists: true }] }
          if (params[4] === 'amenity') await new Promise((resolve) => setTimeout(resolve, 6_000))
          return { rows: [] }
        }
        const adapter = createLocalOsmLocationContextAdapter({ db: { query } as unknown as Pool, checkedAt: '2026-07-26T00:00:00.000Z' })

        const pending = adapter.context(auction())
        await vi.advanceTimersByTimeAsync(7_000)
        await pending

        expect(warn).toHaveBeenCalledTimes(1)
        const line = String(warn.mock.calls[0]?.[0])
        expect(line).toMatch(/slow after 6\d{3}ms .*25\/25 categories done/)
        expect(line).toContain('amenity')
      } finally {
        vi.useRealTimers()
      }
    })

    it('reports a slow uncovered country after the coverage check', async () => {
      vi.useFakeTimers()
      try {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const query = async (sql: string) => {
          if (sql.includes('SELECT EXISTS')) {
            await new Promise((resolve) => setTimeout(resolve, 6_000))
            return { rows: [{ exists: false }] }
          }
          return { rows: [] }
        }
        const adapter = createLocalOsmLocationContextAdapter({ db: { query } as unknown as Pool, checkedAt: '2026-07-26T00:00:00.000Z' })

        const pending = adapter.context(auction())
        await vi.advanceTimersByTimeAsync(7_000)

        await expect(pending).resolves.toBeNull()
        expect(warn).toHaveBeenCalledTimes(1)
        expect(String(warn.mock.calls[0]?.[0])).toMatch(/slow after 6\d{3}ms .*0\/0 categories done/)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
