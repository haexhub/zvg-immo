import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { Auction, HazardAssessment, LandValueBaseline, LocationContext, MarketComparison } from '~/types/auction'

vi.mock('~/server/utils/auction-record', () => ({ readAuctionRecords: vi.fn() }))
vi.mock('~/server/utils/geocode', () => ({ geocodeAddress: vi.fn() }))
vi.mock('~/server/utils/external-data/location-enrichment', () => ({
  readLocationEnrichmentCache: vi.fn(),
  writeLocationEnrichmentCache: vi.fn(),
}))
// No Postgres in tests by default — matches getPool()'s own "no databaseUrl
// configured" contract instead of the real module memoizing a Pool (or null)
// for the whole file the first time any test happens to call it.
vi.mock('~/server/utils/db', () => ({ getPool: vi.fn(() => null) }))

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'test',
    country: 'fr',
    region: 'Paris',
    externalId: '42',
    caseNumber: 'FR-42',
    authority: 'Tribunal',
    title: 'Maison',
    address: 'Paris',
    marketValueEur: 400_000,
    marketValueText: '400.000 EUR',
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
    ...overrides,
  }
}

function records(...auctions: Auction[]) {
  return auctions.map((value) => ({
    auction: value,
    detailsId: null,
    detailsVersion: null,
    artifactVersionId: null,
  }))
}

const marketComparison: MarketComparison = {
  pricePerSqm: 4000,
  basis: 'livingArea',
  areaSqm: 100,
  regionLabel: 'Paris',
  propertyClass: 'house',
  medianPricePerSqm: 5000,
  p25PricePerSqm: 4500,
  p75PricePerSqm: 5500,
  deltaPctVsMedian: -20,
  verdict: 'cheaper',
  samples: 11,
  sources: [{ id: 'fr-dvf-geolocated', label: 'DVF', url: 'https://example.test/dvf', licenseNote: 'Fixture' }],
}

const landValueBaseline: LandValueBaseline = {
  valueEurPerSqm: 850,
  regionLabel: 'Berlin',
  zoneLabel: 'Zone 1',
  distanceMeters: 50,
  source: { id: 'de-boris-d', label: 'BORIS-D', url: 'https://example.test/boris', licenseNote: 'Fixture' },
  checkedAt: '2026-07-26T00:00:00.000Z',
}

const hazard: HazardAssessment = {
  hazard: 'flood',
  status: 'outside',
  severity: 'unknown',
  distanceMeters: 1200,
  sourceLabel: 'EU Flood Risk Areas',
  sourceUrl: 'https://example.test/flood',
  checkedAt: '2026-07-26T00:00:00.000Z',
}

const locationContext: LocationContext = {
  nearbyPlaces: [{ name: 'Paris', kind: 'city', distanceMeters: 500, population: 2_100_000 }],
  mobility: {
    publicTransportLevel: 'excellent',
    nearestStopDistanceMeters: 120,
    stopCountWithin1000m: 25,
    stopCountWithin3000m: 80,
    nearestRailStationDistanceMeters: 300,
    roadAccessLevel: 'major',
    nearestMajorRoadDistanceMeters: 450,
    majorRoadKinds: ['primary'],
    nearestFerryTerminalDistanceMeters: null,
    hasFerryRouteNearby: false,
    ferryAccessLikely: false,
  },
  neighborhood: {
    settlementPattern: 'urban',
    buildingCountWithin500m: 180,
    buildingDensityPerSqKm: 229,
    amenityCountWithin1000m: 45,
    vacantOrRuinCountWithin500m: 0,
    notes: [{ code: 'building_count_500m', params: { count: 180 } }],
  },
  amenities: [
    { kind: 'groceries', nearestDistanceMeters: 250, countWithin1000m: 4, countWithin3000m: 12, countWithin5000m: 20 },
    { kind: 'education', nearestDistanceMeters: 500, countWithin1000m: 2, countWithin3000m: 8, countWithin5000m: 11 },
    { kind: 'healthcare', nearestDistanceMeters: 700, countWithin1000m: 1, countWithin3000m: 6, countWithin5000m: 10 },
    { kind: 'hospital', nearestDistanceMeters: 2000, countWithin1000m: 0, countWithin3000m: 1, countWithin5000m: 2 },
    { kind: 'pharmacy', nearestDistanceMeters: 450, countWithin1000m: 2, countWithin3000m: 5, countWithin5000m: 7 },
    { kind: 'banking', nearestDistanceMeters: 300, countWithin1000m: 3, countWithin3000m: 10, countWithin5000m: 15 },
    { kind: 'fuel', nearestDistanceMeters: 1500, countWithin1000m: 0, countWithin3000m: 2, countWithin5000m: 4 },
    { kind: 'food', nearestDistanceMeters: 120, countWithin1000m: 15, countWithin3000m: 45, countWithin5000m: 80 },
    { kind: 'restaurant', nearestDistanceMeters: 120, countWithin1000m: 10, countWithin3000m: 30, countWithin5000m: 55 },
    { kind: 'cafe', nearestDistanceMeters: 180, countWithin1000m: 5, countWithin3000m: 15, countWithin5000m: 25 },
    { kind: 'leisure', nearestDistanceMeters: 350, countWithin1000m: 4, countWithin3000m: 18, countWithin5000m: 30 },
    { kind: 'recreation', nearestDistanceMeters: 350, countWithin1000m: 4, countWithin3000m: 18, countWithin5000m: 30 },
  ],
  environment: {
    industrialCountWithin1000m: 0,
    industrialCountWithin3000m: 1,
    commercialCountWithin1000m: 2,
    commercialCountWithin3000m: 6,
    nearestIndustrialDistanceMeters: 1800,
    nearestCommercialDistanceMeters: 300,
    nearestHeavyIndustryDistanceMeters: null,
    heavyIndustryKinds: [],
    heavyIndustrySites: [],
    noisyRoadLevel: 'medium',
    aviationNoiseLevel: 'medium',
    nearestMotorwayDistanceMeters: 2200,
    nearestPrimaryRoadDistanceMeters: 600,
    nearestAirportDistanceMeters: 6500,
    nearestRunwayDistanceMeters: 7200,
    nearestHelipadDistanceMeters: null,
    nearestAirportName: null,
    nearestAirportKind: 'unknown',
    riskSignals: ['motorway_near', 'runway_near'],
  },
  demographics: {
    youthSignal: 'high',
    employmentSignal: 'high',
    declineRisk: 'low',
    universityDistanceMeters: 1200,
    schoolOrChildcareCountWithin3000m: 12,
    workplaceSignalCountWithin5000m: 35,
    reasons: ['university_nearby', 'many_workplace_signals'],
    caveats: ['demographic_proxy_only'],
  },
  mapFeatures: [
    { kind: 'groceries', name: 'Supermarkt', lat: 48.857, lng: 2.353, distanceMeters: 120, osmType: 'node', osmId: 1 },
    { kind: 'public_transport', name: 'Haltestelle', lat: 48.858, lng: 2.354, distanceMeters: 180, osmType: 'node', osmId: 2 },
    { kind: 'hospital', name: 'Klinik', lat: 48.859, lng: 2.355, distanceMeters: 900, osmType: 'node', osmId: 3 },
    { kind: 'restaurant', name: 'Bistro', lat: 48.86, lng: 2.356, distanceMeters: 220, osmType: 'node', osmId: 4 },
    { kind: 'runway', name: 'Runway 08/26', lat: 48.87, lng: 2.37, distanceMeters: 7200, osmType: 'way', osmId: 5 },
  ],
  quality: {
    score: 92,
    verdict: 'excellent',
    strengths: ['excellent_public_transport'],
    weaknesses: [],
    caveats: ['osm_heuristic'],
  },
  source: {
    id: 'openstreetmap-overpass',
    label: 'OpenStreetMap / Overpass',
    url: 'https://example.test/osm',
    licenseNote: 'Fixture',
  },
  checkedAt: '2026-07-26T00:00:00.000Z',
}

afterEach(async () => {
  vi.unstubAllGlobals()
  // clearAllMocks only drops recorded calls, so a getPool() stubbed with a
  // fake app_settings pool would otherwise keep serving DB overrides to every
  // later test in this file.
  const { getPool } = await import('~/server/utils/db')
  vi.mocked(getPool).mockReturnValue(null)
  vi.resetModules()
  vi.clearAllMocks()
})

describe('runExternalEnrichment', () => {
  it('writes cached enrichment from market, land-value and hazard adapters', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionRecords).mockResolvedValue(records(auction()))
    vi.mocked(readLocationEnrichmentCache).mockResolvedValue({})
    vi.mocked(writeLocationEnrichmentCache).mockResolvedValue(true)

    const { runExternalEnrichment } = await import('./external-enrichment')
    const summary = await runExternalEnrichment({
      now: new Date('2026-07-26T00:00:00.000Z'),
      marketAdapters: [{
        id: 'dvf-fixture',
        sourceVersion: 'v1',
        supports: () => true,
        compare: vi.fn(async () => marketComparison),
      }],
      landValueAdapters: [{
        id: 'boris-fixture',
        sourceVersion: 'v1',
        supports: () => true,
        baseline: vi.fn(async () => landValueBaseline),
      }],
      hazardAdapters: [{
        id: 'flood-fixture',
        sourceVersion: 'v1',
        supports: () => true,
        assess: vi.fn(async () => [hazard]),
      }],
    })

    expect(summary).toMatchObject({
      processed: 1,
      written: 1,
      marketComparisons: 1,
      landValueBaselines: 1,
      hazards: 1,
      locationContexts: 0,
      staleResults: 0,
      providerFailures: 0,
    })
    expect(writeLocationEnrichmentCache).toHaveBeenCalledWith({
      'test:42': {
        platform: 'test',
        externalId: '42',
        lat: 48.8566,
        lng: 2.3522,
        marketComparison,
        landValueBaseline,
        hazards: [hazard],
        locationContext: null,
        checkedAt: '2026-07-26T00:00:00.000Z',
        sourceVersion: 'dvf-fixture@v1,boris-fixture@v1,flood-fixture@v1',
      },
    })
  })

  it('uses cache-only geocoding and skips auctions without coordinates', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { geocodeAddress } = await import('~/server/utils/geocode')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionRecords).mockResolvedValue(records(auction({ lat: undefined, lng: undefined })))
    vi.mocked(geocodeAddress).mockResolvedValue(null)
    vi.mocked(readLocationEnrichmentCache).mockResolvedValue({})
    vi.mocked(writeLocationEnrichmentCache).mockResolvedValue(true)

    const { runExternalEnrichment } = await import('./external-enrichment')
    const summary = await runExternalEnrichment()

    expect(geocodeAddress).toHaveBeenCalledWith('Paris', 'fr', { fetchMissing: false })
    expect(summary.skippedMissingCoordinates).toBe(1)
    expect(summary.processed).toBe(0)
    expect(writeLocationEnrichmentCache).toHaveBeenCalledWith({})
  })

  it('counts provider failures and continues with other adapters', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionRecords).mockResolvedValue(records(auction()))
    vi.mocked(readLocationEnrichmentCache).mockResolvedValue({})
    vi.mocked(writeLocationEnrichmentCache).mockResolvedValue(true)

    const { runExternalEnrichment } = await import('./external-enrichment')
    const summary = await runExternalEnrichment({
      marketAdapters: [
        {
          id: 'failing',
          sourceVersion: 'v1',
          supports: () => true,
          compare: vi.fn(async () => { throw new Error('boom') }),
        },
        {
          id: 'working',
          sourceVersion: 'v1',
          supports: () => true,
          compare: vi.fn(async () => marketComparison),
        },
      ],
    })

    expect(summary.providerFailures).toBe(1)
    expect(summary.errors).toEqual(['failing market für test/42: boom'])
    expect(summary.marketComparisons).toBe(1)
    expect(summary.written).toBe(1)
  })

  it('writes flood hazards from the default configured GeoJSON adapter', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    vi.stubGlobal('useRuntimeConfig', () => ({
      externalData: {
        frDvfCachePath: '',
        euFloodRiskGeoJsonPath: join(process.cwd(), 'server/utils/external-data/fixtures/eu-flood-risk-zones.fixture.geojson'),
      },
    }))
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionRecords).mockResolvedValue(records(auction()))
    vi.mocked(readLocationEnrichmentCache).mockResolvedValue({})
    vi.mocked(writeLocationEnrichmentCache).mockResolvedValue(true)

    const { runExternalEnrichment } = await import('./external-enrichment')
    const summary = await runExternalEnrichment({
      now: new Date('2026-07-26T00:00:00.000Z'),
      marketAdapters: [],
      landValueAdapters: [],
    })

    expect(summary).toMatchObject({
      processed: 1,
      written: 1,
      hazards: 1,
      staleResults: 0,
      providerFailures: 0,
    })
    expect(writeLocationEnrichmentCache).toHaveBeenCalledWith({
      'test:42': expect.objectContaining({
        hazards: [expect.objectContaining({
          hazard: 'flood',
          status: 'inside',
          severity: 'medium',
          sourceLabel: 'EU Flood Risk Areas',
          checkedAt: '2026-07-26T00:00:00.000Z',
        })],
        sourceVersion: expect.stringContaining('eu-flood-risk-file-cache@'),
      }),
    })
  })

  it('an admin-configured DB override wins over the env-configured GeoJSON path', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    vi.stubGlobal('useRuntimeConfig', () => ({
      externalData: { frDvfCachePath: '', euFloodRiskGeoJsonPath: join(process.cwd(), 'nonexistent.geojson') },
    }))
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionRecords).mockResolvedValue(records(auction()))
    vi.mocked(readLocationEnrichmentCache).mockResolvedValue({})
    vi.mocked(writeLocationEnrichmentCache).mockResolvedValue(true)

    const { getPool } = await import('~/server/utils/db')
    const overridePath = join(process.cwd(), 'server/utils/external-data/fixtures/eu-flood-risk-zones.fixture.geojson')
    const rows = new Map<string, unknown>([['external_data_config_eu-flood-risk-areas', { geoJsonPath: overridePath }]])
    vi.mocked(getPool).mockReturnValue({
      query: async (sql: string, params: unknown[] = []) => {
        const [key] = params as [string]
        return sql.includes('SELECT value FROM app_settings WHERE key =') && rows.has(key)
          ? { rows: [{ value: rows.get(key) }] }
          : { rows: [] }
      },
    } as never)

    const { runExternalEnrichment } = await import('./external-enrichment')
    const summary = await runExternalEnrichment({
      now: new Date('2026-07-26T00:00:00.000Z'),
      marketAdapters: [],
      landValueAdapters: [],
    })

    expect(summary.hazards).toBe(1)
  })

  it('skips only the flood source when its configured GeoJSON cache is missing', async () => {
    // The polygon cache is imported out-of-band, so a path set from /settings
    // is legitimately absent until the first import succeeds. That must not
    // reject the whole run and take market/location enrichment with it.
    vi.stubGlobal('defineTask', (def: unknown) => def)
    vi.stubGlobal('useRuntimeConfig', () => ({
      externalData: { euFloodRiskGeoJsonPath: join(process.cwd(), 'nonexistent.geojson') },
    }))
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionRecords).mockResolvedValue(records(auction()))
    vi.mocked(readLocationEnrichmentCache).mockResolvedValue({})
    vi.mocked(writeLocationEnrichmentCache).mockResolvedValue(true)

    const { runExternalEnrichment } = await import('./external-enrichment')
    const summary = await runExternalEnrichment({
      now: new Date('2026-07-26T00:00:00.000Z'),
      marketAdapters: [],
      landValueAdapters: [],
      locationContextAdapters: [{
        id: 'osm-fixture',
        sourceVersion: 'v1',
        supports: () => true,
        context: vi.fn(async () => locationContext),
      }],
    })

    expect(summary.hazards).toBe(0)
    expect(summary.locationContexts).toBe(1)
    expect(summary.written).toBe(1)
    expect(summary.providerFailures).toBe(1)
    expect(summary.errors[0]).toContain('nonexistent.geojson')
  })

  it('writes wildfire hazards from the default configured EFFIS burnt-area cache adapter', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    vi.stubGlobal('useRuntimeConfig', () => ({
      externalData: {
        frDvfCachePath: '',
        copernicusEffisCachePath: join(process.cwd(), 'server/utils/external-data/fixtures/copernicus-effis-burnt-area.fixture.json'),
      },
    }))
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionRecords).mockResolvedValue(records(auction()))
    vi.mocked(readLocationEnrichmentCache).mockResolvedValue({})
    vi.mocked(writeLocationEnrichmentCache).mockResolvedValue(true)

    const { runExternalEnrichment } = await import('./external-enrichment')
    const summary = await runExternalEnrichment({
      now: new Date('2026-07-26T00:00:00.000Z'),
      marketAdapters: [],
      landValueAdapters: [],
    })

    expect(summary).toMatchObject({ processed: 1, written: 1, hazards: 1, providerFailures: 0 })
    expect(writeLocationEnrichmentCache).toHaveBeenCalledWith({
      'test:42': expect.objectContaining({
        hazards: [expect.objectContaining({
          hazard: 'wildfire',
          status: 'inside',
          severity: 'low',
          sourceLabel: 'Copernicus EFFIS MODIS Burnt Area',
          checkedAt: '2026-07-26T00:00:00.000Z',
        })],
        sourceVersion: expect.stringContaining('copernicus-effis-burnt-area-file-cache@'),
      }),
    })
  })

  it('counts stale hazard results separately', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionRecords).mockResolvedValue(records(auction()))
    vi.mocked(readLocationEnrichmentCache).mockResolvedValue({})
    vi.mocked(writeLocationEnrichmentCache).mockResolvedValue(true)

    const { runExternalEnrichment } = await import('./external-enrichment')
    const summary = await runExternalEnrichment({
      hazardAdapters: [{
        id: 'stale-flood',
        sourceVersion: 'v1',
        supports: () => true,
        assess: vi.fn(async () => [{ ...hazard, stale: true }]),
      }],
      marketAdapters: [],
      landValueAdapters: [],
    })

    expect(summary.hazards).toBe(1)
    expect(summary.staleResults).toBe(1)
  })

  it('writes location context from adapter and preserves it in the source version', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionRecords).mockResolvedValue(records(auction()))
    vi.mocked(readLocationEnrichmentCache).mockResolvedValue({})
    vi.mocked(writeLocationEnrichmentCache).mockResolvedValue(true)

    const { runExternalEnrichment } = await import('./external-enrichment')
    const summary = await runExternalEnrichment({
      marketAdapters: [],
      landValueAdapters: [],
      hazardAdapters: [],
      locationContextAdapters: [{
        id: 'osm-fixture',
        sourceVersion: 'v1',
        supports: () => true,
        context: vi.fn(async () => locationContext),
      }],
    })

    expect(summary.locationContexts).toBe(1)
    expect(summary.written).toBe(1)
    expect(writeLocationEnrichmentCache).toHaveBeenCalledWith({
      'test:42': expect.objectContaining({
        locationContext,
        sourceVersion: 'osm-fixture@v1',
      }),
    })
  })

  it('can scope location enrichment to one country', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionRecords).mockResolvedValue(records(
      auction({ platform: 'se-kronofogden', country: 'se', externalId: '1' }),
      auction({ platform: 'fr-test', country: 'fr', externalId: '2' }),
    ))
    vi.mocked(readLocationEnrichmentCache).mockResolvedValue({})
    vi.mocked(writeLocationEnrichmentCache).mockResolvedValue(true)

    const contextAdapter = {
      id: 'osm-fixture',
      sourceVersion: 'v1',
      supports: vi.fn(() => true),
      context: vi.fn(async () => locationContext),
    }

    const { runExternalEnrichment } = await import('./external-enrichment')
    const summary = await runExternalEnrichment({
      country: 'se',
      marketAdapters: [],
      landValueAdapters: [],
      hazardAdapters: [],
      locationContextAdapters: [contextAdapter],
    })

    expect(summary.processed).toBe(1)
    expect(contextAdapter.context).toHaveBeenCalledTimes(1)
    expect(contextAdapter.context).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'se-kronofogden',
      country: 'se',
      externalId: '1',
    }))
    expect(writeLocationEnrichmentCache).toHaveBeenCalledWith({
      'se-kronofogden:1': expect.objectContaining({
        locationContext,
      }),
    })
  })

  it('queues overlapping task triggers instead of dropping the later scope', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionRecords).mockResolvedValue(records(
      auction({ platform: 'se-kronofogden', country: 'se', externalId: '1' }),
    ))
    vi.mocked(readLocationEnrichmentCache).mockResolvedValue({})
    vi.mocked(writeLocationEnrichmentCache).mockResolvedValue(true)

    let releaseFirst!: () => void
    const firstRunBlocks = new Promise<void>((resolve) => { releaseFirst = resolve })
    const contextAdapter = {
      id: 'osm-fixture',
      sourceVersion: 'v1',
      supports: vi.fn(() => true),
      context: vi.fn(async () => {
        if (contextAdapter.context.mock.calls.length === 1) await firstRunBlocks
        return locationContext
      }),
    }

    const task = (await import('./external-enrichment')).default as {
      run(event?: { payload?: Record<string, unknown> }): Promise<{ result: unknown }>
    }
    const payload = {
      country: 'se',
      marketAdapters: [],
      landValueAdapters: [],
      hazardAdapters: [],
      locationContextAdapters: [contextAdapter],
    }
    const first = task.run({ payload })
    await vi.waitFor(() => expect(contextAdapter.context).toHaveBeenCalledTimes(1))
    const second = task.run({ payload })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(contextAdapter.context).toHaveBeenCalledTimes(1)

    releaseFirst()
    await expect(first).rejects.toThrow('external-enrichment wurde durch einen neueren Lauf beendet')
    await expect(second).resolves.toMatchObject({ result: expect.objectContaining({ processed: 1 }) })
    expect(contextAdapter.context).toHaveBeenCalledTimes(2)
  })

  it('can limit processed auctions for manual spot runs', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionRecords).mockResolvedValue(records(
      auction({ externalId: '1' }),
      auction({ externalId: '2' }),
    ))
    vi.mocked(readLocationEnrichmentCache).mockResolvedValue({})
    vi.mocked(writeLocationEnrichmentCache).mockResolvedValue(true)

    const { runExternalEnrichment } = await import('./external-enrichment')
    const summary = await runExternalEnrichment({
      limit: 1,
      marketAdapters: [{
        id: 'working',
        sourceVersion: 'v1',
        supports: () => true,
        compare: vi.fn(async () => marketComparison),
      }],
    })

    expect(summary.processed).toBe(1)
    expect(summary.written).toBe(1)
  })
})
