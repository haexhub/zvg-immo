import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Auction, LocationEnrichment } from '~/types/auction'
import type { PlatformCrawler } from '../../../crawlers/types'

const registryMock = vi.hoisted(() => ({
  platforms: [] as PlatformCrawler[],
  ensureEnabledCountriesLoaded: vi.fn(),
  isCountryEnabled: vi.fn(() => true),
}))

vi.mock('../../../utils/auction-snapshot', () => ({
  readAuctionSnapshot: vi.fn(),
  applyAuctionPhotos: vi.fn((target: Auction, source: Auction) => {
    if (!target.thumbnailUrl && source.thumbnailUrl) target.thumbnailUrl = source.thumbnailUrl
    if (target.photoCount < source.photoCount) target.photoCount = source.photoCount
    if (source.photoUrls?.length) {
      target.photoUrls = [...new Set([...(target.photoUrls ?? []), ...source.photoUrls])]
    }
  }),
  applySnapshotPhotosToAuctions: vi.fn((auctions: Auction[], snapshot: Record<string, Auction>) => {
    for (const a of auctions) {
      const hit = snapshot[`${a.platform}:${a.externalId}`]
      if (!hit) continue
      if (!a.thumbnailUrl && hit.thumbnailUrl) a.thumbnailUrl = hit.thumbnailUrl
      if (a.photoCount < hit.photoCount) a.photoCount = hit.photoCount
      if (hit.photoUrls?.length) {
        a.photoUrls = [...new Set([...(a.photoUrls ?? []), ...hit.photoUrls])]
      }
    }
  }),
}))
vi.mock('../../../utils/geocode', () => ({ geocodeAddress: vi.fn() }))
vi.mock('../../../utils/external-data/location-enrichment', () => ({ readLocationEnrichment: vi.fn() }))
vi.mock('../../../utils/list-cache', () => ({ readMergedListCache: vi.fn() }))
vi.mock('../../../utils/extraction-cache', () => ({ readExtractionCache: vi.fn(), applyExtractionToAuctions: vi.fn() }))
vi.mock('../../../utils/verkehrswert-cache', () => ({
  cacheKey: (platform: string, id: string) => `${platform}:${id}`,
  readVerkehrswertCache: vi.fn(),
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

  const { readAuctionSnapshot } = await import('../../../utils/auction-snapshot')
  const { geocodeAddress } = await import('../../../utils/geocode')
  const { readLocationEnrichment } = await import('../../../utils/external-data/location-enrichment')
  const { readMergedListCache } = await import('../../../utils/list-cache')
  const { readExtractionCache } = await import('../../../utils/extraction-cache')
  const { readVerkehrswertCache } = await import('../../../utils/verkehrswert-cache')
  const { getRates } = await import('../../../utils/exchange-rate')

  vi.mocked(readAuctionSnapshot).mockResolvedValue({})
  vi.mocked(geocodeAddress).mockResolvedValue(null)
  vi.mocked(readLocationEnrichment).mockResolvedValue(null)
  vi.mocked(readMergedListCache).mockResolvedValue(null)
  vi.mocked(readExtractionCache).mockResolvedValue({})
  vi.mocked(readVerkehrswertCache).mockResolvedValue({})
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
  it('recovers a gallery from the list cache when the detail snapshot is stale', async () => {
    const { readAuctionSnapshot } = await import('../../../utils/auction-snapshot')
    const { readMergedListCache } = await import('../../../utils/list-cache')
    const handler = await loadHandler()

    vi.mocked(readAuctionSnapshot).mockResolvedValue({
      'se-kronofogden:101762': auction({
        platform: 'se-kronofogden',
        country: 'se',
        externalId: '101762',
        photoCount: 0,
        thumbnailUrl: null,
      }),
    })
    vi.mocked(readMergedListCache).mockResolvedValue({
      platform: 'multi',
      source: '',
      countries: ['se'],
      regions: ['all'],
      fetchedAt: '2026-07-28T00:00:00.000Z',
      totalReported: 1,
      auctions: [
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
      ],
    })

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
    const { readAuctionSnapshot } = await import('../../../utils/auction-snapshot')
    const { geocodeAddress } = await import('../../../utils/geocode')
    const { readLocationEnrichment } = await import('../../../utils/external-data/location-enrichment')
    const handler = await loadHandler()

    vi.mocked(readAuctionSnapshot).mockResolvedValue({
      'zvg-portal:7265': auction({ lat: 48.1, lng: 11.5 }),
    })
    vi.mocked(geocodeAddress).mockResolvedValue({ lat: 1, lng: 2, displayName: 'Ignored' } as never)
    vi.mocked(readLocationEnrichment).mockResolvedValue(enrichment)

    await expect(handler({ context: { params: { platform: 'zvg-portal', id: '7265' } } })).resolves.toMatchObject({
      platform: 'zvg-portal',
      externalId: '7265',
      lat: 48.1,
      lng: 11.5,
      locationEnrichment: enrichment,
    })
    expect(readLocationEnrichment).toHaveBeenCalledWith('zvg-portal', '7265')
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
