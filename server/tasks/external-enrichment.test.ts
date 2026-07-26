import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction, HazardAssessment, LandValueBaseline, MarketComparison } from '~/types/auction'

vi.mock('~/server/utils/auction-snapshot', () => ({ readAuctionSnapshot: vi.fn() }))
vi.mock('~/server/utils/geocode', () => ({ geocodeAddress: vi.fn() }))
vi.mock('~/server/utils/external-data/location-enrichment', () => ({
  readLocationEnrichmentCache: vi.fn(),
  writeLocationEnrichmentCache: vi.fn(),
}))

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

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('runExternalEnrichment', () => {
  it('writes cached enrichment from market, land-value and hazard adapters', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { readAuctionSnapshot } = await import('~/server/utils/auction-snapshot')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionSnapshot).mockResolvedValue({ 'test:42': auction() })
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
        checkedAt: '2026-07-26T00:00:00.000Z',
        sourceVersion: 'dvf-fixture@v1,boris-fixture@v1,flood-fixture@v1',
      },
    })
  })

  it('uses cache-only geocoding and skips auctions without coordinates', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { readAuctionSnapshot } = await import('~/server/utils/auction-snapshot')
    const { geocodeAddress } = await import('~/server/utils/geocode')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionSnapshot).mockResolvedValue({
      'test:42': auction({ lat: undefined, lng: undefined }),
    })
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
    const { readAuctionSnapshot } = await import('~/server/utils/auction-snapshot')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionSnapshot).mockResolvedValue({ 'test:42': auction() })
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
    expect(summary.marketComparisons).toBe(1)
    expect(summary.written).toBe(1)
  })

  it('can limit processed auctions for manual spot runs', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { readAuctionSnapshot } = await import('~/server/utils/auction-snapshot')
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('~/server/utils/external-data/location-enrichment')
    vi.mocked(readAuctionSnapshot).mockResolvedValue({
      'test:1': auction({ externalId: '1' }),
      'test:2': auction({ externalId: '2' }),
    })
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
