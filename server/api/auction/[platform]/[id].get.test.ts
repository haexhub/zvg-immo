import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction, LocationEnrichment } from '~/types/auction'
import type { PlatformCrawler } from '../../../crawlers/types'

const registryMock = vi.hoisted(() => ({
  platforms: [] as PlatformCrawler[],
  ensureEnabledCountriesLoaded: vi.fn(),
  isCountryEnabled: vi.fn(() => true),
}))

vi.mock('../../../utils/geocode', () => ({ geocodeAddress: vi.fn() }))
vi.mock('../../../utils/auction-record', () => ({ readAuctionRecord: vi.fn() }))
vi.mock('../../../utils/auction-relationships', () => ({ readAuctionRelationships: vi.fn() }))
vi.mock('../../../utils/external-data/location-enrichment', () => ({ readLocationEnrichment: vi.fn() }))
vi.mock('../../../utils/auction-geo-metrics-read', () => ({ readAuctionGeoMetrics: vi.fn() }))
vi.mock('../../../utils/history', () => ({ readLatestObservedAuction: vi.fn() }))
vi.mock('../../../utils/verkehrswert-cache', () => ({
  cacheKey: (platform: string, id: string) => `${platform}:${id}`,
}))
vi.mock('../../../utils/exchange-rate', () => ({ deriveMarketValueEur: vi.fn(), getRates: vi.fn() }))
vi.mock('../../../crawlers/registry', () => registryMock)

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'zvg-portal',
    country: 'de',
    region: 'Bayern',
    externalId: '7265',
    caseNumber: '12 K 34/26',
    authority: 'AG Muenchen',
    title: 'Einfamilienhaus',
    address: 'Musterstrasse 1, Muenchen',
    marketValueEur: 450_000,
    marketValueText: '450.000 EUR',
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
    ...overrides,
  }
}

const enrichment: LocationEnrichment = {
  platform: 'zvg-portal',
  externalId: '7265',
  lat: 48.137,
  lng: 11.575,
  checkedAt: '2026-07-26T10:00:00.000Z',
  sourceVersion: 'test',
  hazards: [],
  marketComparison: null,
}

async function loadHandler() {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

  const { geocodeAddress } = await import('../../../utils/geocode')
  const { readAuctionRecord } = await import('../../../utils/auction-record')
  const { readAuctionRelationships } = await import('../../../utils/auction-relationships')
  const { readLocationEnrichment } = await import('../../../utils/external-data/location-enrichment')
  const { readAuctionGeoMetrics } = await import('../../../utils/auction-geo-metrics-read')
  const { readLatestObservedAuction } = await import('../../../utils/history')
  const { getRates } = await import('../../../utils/exchange-rate')

  vi.mocked(readAuctionRecord).mockResolvedValue(null)
  vi.mocked(readAuctionRelationships).mockResolvedValue([])
  vi.mocked(geocodeAddress).mockResolvedValue(null)
  vi.mocked(readLocationEnrichment).mockResolvedValue(null)
  vi.mocked(readAuctionGeoMetrics).mockResolvedValue(null)
  vi.mocked(readLatestObservedAuction).mockResolvedValue(null)
  vi.mocked(getRates).mockResolvedValue({ EUR: 1 })

  return (await import('./[id].get')).default as unknown as (event: {
    context: { params: { platform: string; id: string } }
  }) => Promise<unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
  registryMock.platforms.length = 0
  registryMock.isCountryEnabled.mockReturnValue(true)
})

describe('/api/auction/:platform/:id location enrichment overlay', () => {
  it('falls back to the newest observation during the gap before a structured record exists', async () => {
    const { readLatestObservedAuction } = await import('../../../utils/history')
    const handler = await loadHandler()

    vi.mocked(readLatestObservedAuction).mockResolvedValue(
      auction({
        platform: 'se-kronofogden',
        country: 'se',
        externalId: '101762',
        photoCount: 5,
        thumbnailUrl: 'https://example.test/1.jpg',
        photoUrls: [
          'https://example.test/1.jpg',
          'https://example.test/2.jpg',
          'https://example.test/3.jpg',
          'https://example.test/4.jpg',
          'https://example.test/5.jpg',
        ],
      }),
    )

    await expect(handler({ context: { params: { platform: 'se-kronofogden', id: '101762' } } })).resolves.toMatchObject({
      platform: 'se-kronofogden',
      externalId: '101762',
      photoCount: 5,
      thumbnailUrl: 'https://example.test/1.jpg',
      photoUrls: [
        'https://example.test/1.jpg',
        'https://example.test/2.jpg',
        'https://example.test/3.jpg',
        'https://example.test/4.jpg',
        'https://example.test/5.jpg',
      ],
    })
  })

  it('returns cached locationEnrichment without live external fetches', async () => {
    const { readAuctionRecord } = await import('../../../utils/auction-record')
    const { geocodeAddress } = await import('../../../utils/geocode')
    const { readLocationEnrichment } = await import('../../../utils/external-data/location-enrichment')
    const { readAuctionRelationships } = await import('../../../utils/auction-relationships')
    const handler = await loadHandler()

    vi.mocked(readAuctionRecord).mockResolvedValue({
      auction: auction({ lat: 48.1, lng: 11.5 }),
      detailsId: 1,
      detailsVersion: 1,
      artifactVersionId: null,
    })
    vi.mocked(geocodeAddress).mockResolvedValue({ lat: 1, lng: 2, displayName: 'Ignored' } as never)
    vi.mocked(readLocationEnrichment).mockResolvedValue(enrichment)
    vi.mocked(readAuctionRelationships).mockResolvedValue([{
      platform: 'zvbawu', externalId: '1330381', kind: 'same_proceeding', confidence: 'high',
      country: 'de', region: 'Baden-Württemberg', authority: 'Biberach', caseNumber: '2 K 15/18',
      title: 'Doppelhaushälfte', address: 'Am Annaweiher 17, 17/1, 88447 Warthausen',
      auctionDateIso: '2026-10-01T09:00:00.000Z', auctionDateText: '01.10.2026, 09:00 Uhr', marketValueEur: 451000,
    }])

    await expect(handler({ context: { params: { platform: 'zvg-portal', id: '7265' } } })).resolves.toMatchObject({
      platform: 'zvg-portal',
      externalId: '7265',
      lat: 48.1,
      lng: 11.5,
      locationEnrichment: enrichment,
      relatedAuctions: [expect.objectContaining({ externalId: '1330381', kind: 'same_proceeding' })],
    })
    expect(readLocationEnrichment).toHaveBeenCalledWith('zvg-portal', '7265')
    expect(readAuctionRelationships).toHaveBeenCalledWith('zvg-portal', '7265')
  })

  it('still returns the auction when the optional geo-metrics read fails', async () => {
    const { readAuctionRecord } = await import('../../../utils/auction-record')
    const { readAuctionGeoMetrics } = await import('../../../utils/auction-geo-metrics-read')
    const handler = await loadHandler()

    vi.mocked(readAuctionRecord).mockResolvedValue({
      auction: auction({ lat: 48.1, lng: 11.5 }),
      detailsId: 1,
      detailsVersion: 1,
      artifactVersionId: null,
    })
    vi.mocked(readAuctionGeoMetrics).mockRejectedValueOnce(new Error('database unavailable'))

    await expect(handler({ context: { params: { platform: 'zvg-portal', id: '7265' } } })).resolves.toMatchObject({
      platform: 'zvg-portal',
      leisureTourism: {
        eigennutzung: { label: 'keine_angaben', criteria: null },
        wirtschaftlich: { label: 'keine_angaben', criteria: null },
      },
    })
  })

  it('treats a findOne miss as definitive and skips the region crawl', async () => {
    const findOne = vi.fn().mockResolvedValue(null)
    const crawl = vi.fn().mockResolvedValue({
      platform: 'se-kronofogden',
      source: 'test',
      countries: ['se'],
      regions: ['all'],
      fetchedAt: new Date().toISOString(),
      totalReported: 0,
      auctions: [],
    })
    registryMock.platforms.push({
      id: 'se-kronofogden',
      name: 'Kronofogden',
      baseUrl: 'https://auktionstorget.kronofogden.se',
      country: 'se',
      regions: [{ code: 'all', name: 'All' }],
      crawl,
      findOne,
    })
    const handler = await loadHandler()

    await expect(handler({ context: { params: { platform: 'se-kronofogden', id: '999999' } } })).rejects.toMatchObject({
      statusCode: 404,
    })

    expect(findOne).toHaveBeenCalledWith('999999')
    expect(crawl).not.toHaveBeenCalled()
  })

  it('resolves the human-readable source platform from the registry', async () => {
    const { readAuctionRecord } = await import('../../../utils/auction-record')
    registryMock.platforms.push({
      id: 'zvg-portal',
      name: 'ZVG-Portal',
      baseUrl: 'https://www.zvg-portal.de',
      country: 'de',
      regions: [{ code: 'all', name: 'All' }],
      crawl: vi.fn(),
    })
    const handler = await loadHandler()

    vi.mocked(readAuctionRecord).mockResolvedValue({
      auction: auction(),
      detailsId: 1,
      detailsVersion: 1,
      artifactVersionId: null,
    })

    await expect(handler({ context: { params: { platform: 'zvg-portal', id: '7265' } } })).resolves.toMatchObject({
      sourcePlatform: { name: 'ZVG-Portal', url: 'https://www.zvg-portal.de' },
    })
  })

  it('leaves the source platform null when the registry has no matching entry', async () => {
    const { readAuctionRecord } = await import('../../../utils/auction-record')
    const handler = await loadHandler()

    vi.mocked(readAuctionRecord).mockResolvedValue({
      auction: auction(),
      detailsId: 1,
      detailsVersion: 1,
      artifactVersionId: null,
    })

    await expect(handler({ context: { params: { platform: 'zvg-portal', id: '7265' } } })).resolves.toMatchObject({
      sourcePlatform: null,
    })
  })

  it('caches live lookup misses briefly', async () => {
    const crawl = vi.fn().mockResolvedValue({
      platform: 'test-platform',
      source: 'test',
      countries: ['de'],
      regions: ['All'],
      fetchedAt: new Date().toISOString(),
      totalReported: 0,
      auctions: [],
    })
    registryMock.platforms.push({
      id: 'test-platform',
      name: 'Test Platform',
      baseUrl: 'https://example.test',
      country: 'de',
      regions: [{ code: 'all', name: 'All' }],
      crawl,
    })
    const handler = await loadHandler()
    const event = { context: { params: { platform: 'test-platform', id: 'missing' } } }

    await expect(handler(event)).rejects.toMatchObject({ statusCode: 404 })
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 404 })

    expect(crawl).toHaveBeenCalledOnce()
    expect(registryMock.ensureEnabledCountriesLoaded).toHaveBeenCalledOnce()
  })
})
