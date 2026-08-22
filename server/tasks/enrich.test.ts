import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment, Auction, CrawlResult } from '~/types/auction'
import type { AuctionFetchState } from '../utils/auction-fetch-state'
import { crawlAll } from '../crawlers/registry'
import { ensureAuctionIdentity, upsertCurrentAuctions } from '../utils/current-auctions'
import { writeAuctionDetails } from '../utils/auction-details'
import { readAuctionRecordMap } from '../utils/auction-record'
import { readLatestArtifactVersions } from '../utils/artifact-version-state'
import {
  readAuctionFetchStates,
  writeAuctionCrawlFetchState,
  writeAuctionEnrichClaim,
  writeAuctionPhotoPipelineState,
} from '../utils/auction-fetch-state'
import { downloadNativeImages } from '../utils/extract/native-images'
import { extractDocumentPhotos } from '../utils/extract/document-images'
import { archiveAuction } from '../utils/raw-archive'
import { recordObservations } from '../utils/history'
import { recordCrawlScope } from '../utils/crawl-state'

vi.mock('../crawlers/registry', () => ({
  crawlAll: vi.fn(),
  ensureEnabledCountriesLoaded: vi.fn(async () => []),
  listRegions: vi.fn(() => []),
  platforms: [],
}))
vi.mock('../utils/current-auctions', () => ({ ensureAuctionIdentity: vi.fn(), upsertCurrentAuctions: vi.fn() }))
vi.mock('../utils/auction-relationships', () => ({ rebuildAutomaticAuctionRelationships: vi.fn() }))
vi.mock('../utils/auction-details', () => ({ writeAuctionDetails: vi.fn() }))
vi.mock('../utils/auction-record', () => ({ readAuctionRecordMap: vi.fn() }))
vi.mock('../utils/artifact-version-state', () => ({ readLatestArtifactVersions: vi.fn() }))
vi.mock('../utils/auction-fetch-state', () => ({
  readAuctionFetchStates: vi.fn(),
  writeAuctionCrawlFetchState: vi.fn(),
  writeAuctionEnrichClaim: vi.fn(),
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
vi.mock('../utils/crawl-state', () => ({ recordCrawlScope: vi.fn() }))
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

function fetchState(overrides: Partial<AuctionFetchState> = {}): AuctionFetchState {
  return {
    platform: 'test-platform',
    externalId: '42',
    pdfUrl: null,
    pdfUrlUpstream: null,
    detailUrl: null,
    detailUrlUpstream: null,
    attachments: [],
    photoUrls: ['https://example.test/front.jpg'],
    sourceUpdatedIso: null,
    detailFetchedAt: '2026-08-01T10:00:00.000Z',
    enrichClaimedAt: null,
    llmBatchJob: null,
    llmArtifactVersionId: null,
    llmRulesHint: null,
    llmFailures: 0,
    llmLastAttemptedAt: null,
    llmClaimedAt: null,
    photosCheckedAt: null,
    photoFailures: 0,
    photoLastAttemptedAt: null,
    photoPipelineVersion: 1,
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  }
}

function crawlResult(auctions: Auction[]): CrawlResult & { errors: [] } {
  return {
    platform: 'all',
    platformsSucceeded: ['zvg-portal'],
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
  vi.mocked(downloadNativeImages).mockResolvedValue([])
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

    await runEnrich({ country: 'de', recordCrawlScope: true })

    expect(recordCrawlScope).toHaveBeenCalledWith('de', 'Berlin', result, expect.any(String))
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

  it('claims an identity before working on it and clears the claim once the iteration finishes', async () => {
    const listing = auction()
    vi.mocked(crawlAll).mockResolvedValue(crawlResult([listing]))

    await runEnrich({ country: 'de' })

    expect(writeAuctionEnrichClaim).toHaveBeenNthCalledWith(1, 'test-platform', '42', expect.any(String))
    expect(writeAuctionEnrichClaim).toHaveBeenNthCalledWith(2, 'test-platform', '42', null)
    // writeAuctionPhotoPipelineState is per-item-only (unlike
    // writeAuctionCrawlFetchState, which is also called once up front for the
    // raw region-crawl result before this worker loop even starts) — a solid
    // anchor for "the claim was set before this iteration's work began".
    expect(vi.mocked(writeAuctionEnrichClaim).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(writeAuctionPhotoPipelineState).mock.invocationCallOrder[0]!)
  })

  it('checks native photos on the first pass and writes details only once', async () => {
    const listing = { ...auction(), photoUrls: ['https://example.test/front.jpg'] }
    vi.mocked(crawlAll).mockResolvedValue(crawlResult([listing]))

    await runEnrich({ country: 'de' })

    expect(downloadNativeImages).toHaveBeenCalledWith(
      ['https://example.test/front.jpg'],
      expect.objectContaining({ destDir: expect.stringContaining('/test-platform/42') }),
    )
    expect(writeAuctionPhotoPipelineState).toHaveBeenCalledWith('test-platform', '42', {
      photosCheckedAt: expect.any(String),
      photoFailures: 0,
      photoPipelineVersion: expect.any(Number),
      photoAttempted: true,
    })
    expect(writeAuctionDetails).toHaveBeenCalledTimes(1)
  })

  it('retries the photo pipeline past MAX_PHOTO_FAILURES once the cooldown elapsed', async () => {
    const listing = { ...auction(), photoUrls: ['https://example.test/front.jpg'] }
    vi.mocked(crawlAll).mockResolvedValue(crawlResult([listing]))
    vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map([
      ['test-platform:42', fetchState({
        photoFailures: 3,
        photoLastAttemptedAt: '2026-01-01T00:00:00.000Z',
      })],
    ]))

    await runEnrich({ country: 'de' })

    expect(downloadNativeImages).toHaveBeenCalled()
  })

  it('does not retry the photo pipeline within the cooldown window', async () => {
    const listing = { ...auction(), photoUrls: ['https://example.test/front.jpg'] }
    vi.mocked(crawlAll).mockResolvedValue(crawlResult([listing]))
    vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map([
      ['test-platform:42', fetchState({
        photoFailures: 3,
        photoLastAttemptedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      })],
    ]))

    await runEnrich({ country: 'de' })

    expect(downloadNativeImages).not.toHaveBeenCalled()
  })

  it('keeps successfully downloaded native photos when document extraction fails', async () => {
    const attachment: Attachment = {
      kind: 'appraisal',
      label: 'Gutachten',
      filename: 'gutachten.pdf',
      sizeBytes: null,
      fileId: 'gutachten',
      proxyUrl: 'https://example.test/gutachten.pdf',
    }
    const listing = { ...auction(), photoUrls: ['https://example.test/front.jpg'], attachments: [attachment] }
    vi.mocked(crawlAll).mockResolvedValue(crawlResult([listing]))
    vi.mocked(downloadNativeImages).mockResolvedValue(['abc123.jpg'])
    vi.mocked(extractDocumentPhotos).mockRejectedValue(new Error('pdfimages extraction failed'))

    await runEnrich({ country: 'de' })

    expect(writeAuctionDetails).toHaveBeenCalledWith(
      listing,
      expect.objectContaining({ photos: [expect.objectContaining({ file: 'abc123.jpg' })] }),
      expect.anything(),
    )
    expect(writeAuctionPhotoPipelineState).toHaveBeenCalledWith('test-platform', '42', {
      photosCheckedAt: null,
      photoFailures: 1,
      photoPipelineVersion: null,
      photoAttempted: true,
    })
  })
})

describe('runEnrich scoped identity retry', () => {
  it('skips the live crawl and force-reprocesses exactly the requested identity, bypassing finalizeEnrichPersistence', async () => {
    const listing = auction()
    vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map([
      ['test-platform:42', { auction: listing, detailsId: 1, detailsVersion: 1, artifactVersionId: 5 }],
    ]))
    // Looks already-done (detailFetchedAt set) — without identities forcing
    // it, needsEnrich would skip it entirely.
    vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map([
      ['test-platform:42', fetchState({ detailFetchedAt: '2026-08-01T10:00:00.000Z' })],
    ]))

    const outcome = await runEnrich({ identities: [{ platform: 'test-platform', externalId: '42' }] })

    expect(crawlAll).not.toHaveBeenCalled()
    expect(archiveAuction).toHaveBeenCalledWith(listing, expect.any(String))
    expect(upsertCurrentAuctions).toHaveBeenCalledWith([listing], expect.any(String))
    // finalizeEnrichPersistence's country-wide bookkeeping doesn't apply to a
    // scoped retry — recordObservations would otherwise fire here too.
    expect(recordObservations).not.toHaveBeenCalled()
    expect(outcome.result).toMatchObject({ crawled: 1, archived: 1 })
  })

  it('replaces a stale cached photo set instead of merging into it on a forced single-auction retry', async () => {
    const listing = { ...auction(), attachments: [{
      kind: 'photo' as const,
      label: 'Foto',
      filename: 'foto.pdf',
      sizeBytes: null,
      fileId: 'foto',
      proxyUrl: 'https://example.test/foto.pdf',
    }] }
    const staleExtraction = {
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      units: null,
      source: 'rules' as const,
      confidence: 'low' as const,
      at: '2026-08-01T10:00:00.000Z',
      photos: [{ file: 'stale-wrong-auction.jpg', category: 'sonstiges' as const, caption: null, isPropertyPhoto: true }],
    }
    vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map([
      ['test-platform:42', { auction: { ...listing, extraction: staleExtraction }, detailsId: 1, detailsVersion: 1, artifactVersionId: 5 }],
    ]))
    // photoPipelineVersion already at the current target — without scopedForce
    // taken into account, rebuildingPhotoSet would stay false here.
    vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map([
      ['test-platform:42', fetchState({ detailFetchedAt: '2026-08-01T10:00:00.000Z', photosCheckedAt: '2026-08-01T10:00:00.000Z', photoPipelineVersion: 4 })],
    ]))
    vi.mocked(extractDocumentPhotos).mockResolvedValue(['freshly-correct.jpg'])

    await runEnrich({ identities: [{ platform: 'test-platform', externalId: '42' }] })

    expect(writeAuctionDetails).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ photos: [expect.objectContaining({ file: 'freshly-correct.jpg' })] }),
      expect.anything(),
    )
  })

  it('drops identities that no longer exist in the records map instead of throwing', async () => {
    vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map())

    const outcome = await runEnrich({ identities: [{ platform: 'test-platform', externalId: 'gone' }] })

    expect(crawlAll).not.toHaveBeenCalled()
    expect(outcome.result).toMatchObject({ crawled: 0, archived: 0 })
  })
})
