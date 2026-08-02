import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction, CrawlResult } from '~/types/auction'
import { crawlAll } from '../crawlers/registry'
import { ensureAuctionIdentity, upsertCurrentAuctions } from '../utils/current-auctions'
import { writeAuctionDetails } from '../utils/auction-details'
import { readAuctionRecordMap } from '../utils/auction-record'
import { readLatestArtifactVersions } from '../utils/artifact-version-state'
import { readAuctionFetchStates, writeAuctionCrawlFetchState } from '../utils/auction-fetch-state'
import { archiveAuction } from '../utils/raw-archive'
import { recordObservations } from '../utils/history'
import { writeListCache } from '../utils/list-cache'

vi.mock('../crawlers/registry', () => ({ crawlAll: vi.fn(), platforms: [] }))
vi.mock('../utils/current-auctions', () => ({ ensureAuctionIdentity: vi.fn(), upsertCurrentAuctions: vi.fn() }))
vi.mock('../utils/auction-details', () => ({ writeAuctionDetails: vi.fn() }))
vi.mock('../utils/auction-record', () => ({ readAuctionRecordMap: vi.fn() }))
vi.mock('../utils/artifact-version-state', () => ({ readLatestArtifactVersions: vi.fn() }))
vi.mock('../utils/auction-fetch-state', () => ({
  readAuctionFetchStates: vi.fn(),
  writeAuctionCrawlFetchState: vi.fn(),
  writeAuctionPhotoPipelineState: vi.fn(),
}))
vi.mock('../utils/exchange-rate', () => ({ getRates: vi.fn(async () => ({})), deriveMarketValueEur: vi.fn() }))
vi.mock('../utils/alert-matching', () => ({ matchAlerts: vi.fn() }))
vi.mock('../utils/extract/native-images', () => ({ downloadNativeImages: vi.fn() }))
vi.mock('../utils/extract/document-images', () => ({ extractDocumentPhotos: vi.fn() }))
vi.mock('../utils/extract/llm-documents', () => ({
  prepareLiveLlmDocuments: vi.fn(async () => ({
    documentSetComplete: true,
    documentSetItems: [],
    documents: [],
    errors: [],
  })),
}))
vi.mock('../utils/image-storage', () => ({
  imagesBucketConfigured: vi.fn(() => false),
  mimeTypeFor: vi.fn(),
  uploadImage: vi.fn(),
}))
vi.mock('../utils/raw-archive', () => ({
  archiveAuction: vi.fn(),
  archiveDocumentSet: vi.fn(),
  archivePhotoBlob: vi.fn(),
}))
vi.mock('../utils/verkehrswert-cache', () => ({
  cacheKey: (platform: string, externalId: string) => `${platform}:${externalId}`,
  readVerkehrswertCache: vi.fn(async () => ({})),
}))
vi.mock('../utils/history', () => ({ recordObservations: vi.fn() }))
vi.mock('../utils/list-cache', () => ({ writeListCache: vi.fn() }))
vi.mock('../utils/task-runs', () => ({
  recordTaskRunStart: vi.fn(),
  recordTaskRunEnd: vi.fn(),
  recordTaskRunProgress: vi.fn(),
}))
vi.mock('../utils/task-run-errors', () => ({ recordTaskRunError: vi.fn() }))
vi.stubGlobal('defineTask', (definition: unknown) => definition)

const { runEnrich } = await import('./enrich')

function auction(): Auction {
  return {
    platform: 'test-platform',
    country: 'de',
    region: 'Berlin',
    externalId: '42',
    caseNumber: '1 K 1/26',
    authority: 'AG Berlin',
    title: 'Wohnhaus',
    address: null,
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: '2026-09-01T10:00:00.000Z',
    auctionDateText: '01.09.2026',
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    pdfUrlUpstream: null,
    detailUrl: null,
    detailUrlUpstream: null,
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
  }
}

function crawlResult(auctions: Auction[]): CrawlResult & { errors: [] } {
  return {
    platform: 'all',
    source: 'all',
    countries: ['de'],
    regions: ['Berlin'],
    fetchedAt: '2026-08-02T10:00:00.000Z',
    totalReported: auctions.length,
    auctions,
    errors: [],
  }
}

beforeEach(() => {
  vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map())
  vi.mocked(readLatestArtifactVersions).mockResolvedValue(new Map())
  vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map())
  vi.mocked(writeAuctionDetails).mockResolvedValue({ version: 1, changed: true })
})

afterEach(() => vi.clearAllMocks())

describe('runEnrich structured persistence', () => {
  it('passes an explicit country to the crawl and persists the empty result', async () => {
    const result = crawlResult([])
    vi.mocked(crawlAll).mockResolvedValue(result)

    const outcome = await runEnrich({ country: 'de' })

    expect(crawlAll).toHaveBeenCalledWith(expect.objectContaining({ country: 'de' }))
    expect(ensureAuctionIdentity).toHaveBeenCalledWith([])
    expect(writeAuctionCrawlFetchState).toHaveBeenCalledWith([])
    expect(recordObservations).toHaveBeenCalledWith(result, expect.any(String))
    expect(upsertCurrentAuctions).toHaveBeenCalledWith([], expect.any(String))
    expect(outcome.result).toMatchObject({ crawled: 0, archived: 0, failed: 0 })
  })

  it('creates an identity before archiving a regional listing', async () => {
    const listing = auction()
    const result = crawlResult([listing])
    vi.mocked(crawlAll).mockImplementation(async (options) => {
      await options?.onRegionResult?.('de', 'Berlin', result)
      return result
    })

    await runEnrich({ country: 'de', writeListCache: true })

    expect(writeListCache).toHaveBeenCalledWith('de', 'Berlin', result)
    expect(ensureAuctionIdentity).toHaveBeenCalledWith([listing])
    expect(archiveAuction).toHaveBeenCalledWith(listing, expect.any(String))
    expect(vi.mocked(ensureAuctionIdentity).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(archiveAuction).mock.invocationCallOrder[0]!)
    expect(writeAuctionDetails).toHaveBeenCalledWith(
      listing,
      expect.objectContaining({ source: 'rules', confidence: 'low' }),
      { artifactVersionId: null },
    )
  })
})
