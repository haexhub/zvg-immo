import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction, AuctionExtraction } from '~/types/auction'
import { downloadBlob, findLatestCapture } from '../utils/storage-download'
import { getPool } from '../utils/db'
import { readAuctionRecordMap } from '../utils/auction-record'
import { readAuctionFetchStates, writeAuctionLlmPipelineState } from '../utils/auction-fetch-state'
import { readArtifactProcessingState } from '../utils/artifact-version-state'
import { readExtractionChainStrategy, readExtractionLlmConfigChain } from '../utils/extract/llm-task-config'
import { readLlmExecutionMode } from '../utils/app-settings'
import { submitLlmBatch } from '../utils/extract/llm-batch'
import { extractByLlm } from '../utils/extract/llm'
import { prepareArchivedLlmDocuments } from '../utils/extract/llm-documents'
import { writeAuctionDetails } from '../utils/auction-details'
import { upsertCurrentAuctions } from '../utils/current-auctions'

vi.mock('../utils/storage-download', () => ({
  findLatestCapture: vi.fn(),
  downloadBlob: vi.fn(),
  readDocumentSet: vi.fn(async () => null),
}))
vi.mock('../utils/db', () => ({ getPool: vi.fn() }))
vi.mock('../utils/auction-record', () => ({ readAuctionRecordMap: vi.fn() }))
vi.mock('../utils/auction-fetch-state', () => ({
  readAuctionFetchStates: vi.fn(),
  writeAuctionLlmPipelineState: vi.fn(),
}))
vi.mock('../utils/artifact-version-state', () => ({
  hasUnparsedArtifactVersion: vi.fn((state) => state.latest != null && state.latest.id !== state.parsedArtifactVersionId),
  readArtifactProcessingState: vi.fn(),
}))
vi.mock('../utils/extract/llm-task-config', () => ({
  MAX_LLM_FAILURES: 3,
  readExtractionChainStrategy: vi.fn(),
  readExtractionLlmConfigChain: vi.fn(),
}))
vi.mock('../utils/app-settings', () => ({ readLlmExecutionMode: vi.fn() }))
vi.mock('../utils/extract/llm-batch', () => ({
  isLlmBatchPending: vi.fn(() => false),
  isLlmBatchProviderBroken: vi.fn(async () => false),
  submitLlmBatch: vi.fn(),
  supportsLlmBatch: vi.fn((config) => config != null),
  supportsNativeBatchDocuments: vi.fn(() => false),
  batchSupportsMultimodal: vi.fn((config) => config?.provider !== 'openrouter'),
}))
vi.mock('../utils/extract/llm', () => ({
  extractByLlm: vi.fn(),
  isDailyQuotaError: vi.fn(() => false),
  isLlmProviderError: vi.fn(() => false),
  isLlmProviderUnavailable: vi.fn(() => false),
  isRateLimitError: vi.fn(() => false),
}))
vi.mock('../utils/extract/llm-documents', () => ({
  prepareArchivedLlmDocuments: vi.fn(async (_auction, opts) => ({
    input: {},
    documentSetItems: [],
    documentSetComplete: true,
    artifactVersionId: opts.artifactVersionId,
  })),
}))
vi.mock('../utils/auction-details', () => ({ writeAuctionDetails: vi.fn() }))
vi.mock('../utils/current-auctions', () => ({ upsertCurrentAuctions: vi.fn() }))
vi.mock('../crawlers/registry', () => ({
  ensureEnabledCountriesLoaded: vi.fn(),
  getEnabledCountryCodes: vi.fn(() => ['de']),
  isCountryEnabled: vi.fn(() => true),
}))
vi.mock('../utils/task-runs', () => ({
  recordTaskRunStart: vi.fn(),
  recordTaskRunEnd: vi.fn(),
  recordTaskRunProgress: vi.fn(),
}))

vi.stubGlobal('defineTask', (definition: unknown) => definition)

const { reprocessAuction, runReprocess } = await import('./reprocess')

const emptyArtifactState = {
  latest: null,
  parsedArtifactVersionId: null,
}

function auction(): Auction {
  return {
    platform: 'zvg-portal',
    country: 'de',
    region: 'Berlin',
    externalId: '7265',
    caseNumber: '12 K 34/26',
    authority: 'AG Berlin',
    title: 'Einfamilienhaus',
    address: null,
    marketValueEur: null,
    marketValueText: null,
    auctionDateIso: null,
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    pdfUrlUpstream: null,
    detailUrl: null,
    detailUrlUpstream: null,
    attachments: [],
    description: 'Wohnflaeche 120 m2, Grundstueck 500 m2.',
    photoCount: 0,
    thumbnailUrl: null,
  }
}

function extraction(overrides: Partial<AuctionExtraction> = {}): AuctionExtraction {
  return {
    propertyType: 'einfamilienhaus',
    landAreaSqm: 500,
    livingAreaSqm: 120,
    rooms: 4,
    units: 1,
    source: 'llm',
    confidence: 'high',
    at: '2026-08-01T10:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { maxPerRun: '10' } }))
  vi.mocked(getPool).mockReturnValue({
    query: vi.fn(async () => ({ rows: [{ platform: 'zvg-portal', external_id: '7265' }] })),
  } as never)
  vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map([['zvg-portal:7265', {
    auction: auction(),
    detailsId: 7,
    detailsVersion: 2,
    artifactVersionId: null,
  }]]))
  vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map())
  vi.mocked(readArtifactProcessingState).mockResolvedValue(emptyArtifactState)
  vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([])
  vi.mocked(readExtractionChainStrategy).mockResolvedValue('fallback')
  vi.mocked(readLlmExecutionMode).mockResolvedValue('sync')
  vi.mocked(findLatestCapture).mockResolvedValue({
    contentHash: 'auction-hash',
    sourceUrl: null,
    capturedAt: '2026-08-02T10:00:00.000Z',
  })
  vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction())))
  vi.mocked(writeAuctionDetails).mockResolvedValue({ version: 3, changed: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('reprocessAuction structured provenance', () => {
  it('returns null when no archived auction capture exists', async () => {
    vi.mocked(findLatestCapture).mockResolvedValue(null)

    await expect(reprocessAuction(
      'zvg-portal',
      'missing',
      undefined,
      null,
      '2026-08-02T11:00:00.000Z',
      { artifactState: emptyArtifactState },
    )).resolves.toBeNull()

    expect(downloadBlob).not.toHaveBeenCalled()
  })

  it('returns null when archived auction bytes cannot be loaded', async () => {
    vi.mocked(findLatestCapture).mockResolvedValue({
      contentHash: 'missing-blob',
      sourceUrl: null,
      capturedAt: '2026-08-02T10:00:00.000Z',
    })
    vi.mocked(downloadBlob).mockResolvedValue(null)

    await expect(reprocessAuction(
      'zvg-portal',
      '7265',
      undefined,
      null,
      '2026-08-02T11:00:00.000Z',
      { artifactState: emptyArtifactState },
    )).resolves.toBeNull()
  })

  it('keeps the parsed artifact pointer when only rules run', async () => {
    vi.mocked(findLatestCapture).mockResolvedValue({
      contentHash: 'auction-hash',
      sourceUrl: null,
      capturedAt: '2026-08-02T10:00:00.000Z',
    })
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction())))

    const result = await reprocessAuction(
      'zvg-portal',
      '7265',
      undefined,
      null,
      '2026-08-02T11:00:00.000Z',
      {
        priorLlmFailures: 2,
        artifactState: {
          latest: {
            id: 22,
            platform: 'zvg-portal',
            externalId: '7265',
            version: 2,
            setHash: 'latest-hash',
          },
          parsedArtifactVersionId: 11,
        },
      },
    )

    expect(result).toMatchObject({
      llmCalled: false,
      llmFailures: 2,
      artifactVersionId: 11,
      entry: { source: 'rules', confidence: 'high' },
    })
  })
})

describe('runReprocess structured persistence', () => {
  it('persists a synchronous rules result before updating the current projection', async () => {
    await expect(runReprocess({ country: 'de' })).resolves.toMatchObject({ processed: 1, skipped: 0 })

    expect(writeAuctionDetails).toHaveBeenCalledWith(
      expect.objectContaining({ extraction: expect.objectContaining({ source: 'rules' }) }),
      expect.objectContaining({ source: 'rules' }),
      { artifactVersionId: null },
    )
    expect(writeAuctionLlmPipelineState).toHaveBeenCalledWith('zvg-portal', '7265', {
      llmBatchJob: null,
      llmArtifactVersionId: null,
      llmFailures: 0,
    })
    expect(vi.mocked(writeAuctionDetails).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(upsertCurrentAuctions).mock.invocationCallOrder[0]!)
  })

  it('preserves visible details and records exact artifact provenance for a submitted batch', async () => {
    const prior = extraction({ condition: 'gepflegt', documentSummary: 'Bisherige Zusammenfassung' })
    vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map([['zvg-portal:7265', {
      auction: { ...auction(), extraction: prior },
      detailsId: 7,
      detailsVersion: 2,
      artifactVersionId: 11,
    }]]))
    vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map([['zvg-portal:7265', {
      platform: 'zvg-portal', externalId: '7265', pdfUrl: null, pdfUrlUpstream: null,
      detailUrl: null, detailUrlUpstream: null, attachments: [], photoUrls: null,
      sourceUpdatedIso: null, detailFetchedAt: null, llmBatchJob: null,
      llmArtifactVersionId: null, llmFailures: 2, photosCheckedAt: null,
      photoFailures: 0, photoPipelineVersion: null,
      updatedAt: '2026-08-02T10:00:00.000Z',
    }]]))
    vi.mocked(readArtifactProcessingState).mockResolvedValue({
      latest: {
        id: 22, platform: 'zvg-portal', externalId: '7265', version: 3, setHash: 'set-22',
      },
      parsedArtifactVersionId: 11,
    })
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{
      baseUrl: 'https://api.example.test', apiKey: 'secret', model: 'batch-model', provider: 'openai-compatible',
    }])
    vi.mocked(submitLlmBatch).mockResolvedValue({
      jobName: 'batch-22',
      submitted: [{ key: 'zvg-portal:7265', jobName: 'batch-22' }],
      retryItems: [],
    })

    await expect(runReprocess({ country: 'de', batch: true })).resolves.toMatchObject({ processed: 1 })

    expect(writeAuctionDetails).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ condition: 'gepflegt', documentSummary: 'Bisherige Zusammenfassung' }),
      { artifactVersionId: 11 },
    )
    expect(writeAuctionLlmPipelineState).toHaveBeenLastCalledWith('zvg-portal', '7265', {
      llmBatchJob: 'batch-22',
      llmArtifactVersionId: 22,
      llmFailures: 2,
    })
  })

  it('routes a candidate needing multimodal content to the synchronous path when the configured batch provider is OpenRouter (text-only)', async () => {
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{
      baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test', model: 'google/gemini-3.5-flash-lite', provider: 'openrouter',
    }])
    vi.mocked(prepareArchivedLlmDocuments).mockResolvedValueOnce({
      input: { pdfPageImages: ['base64page1'] },
      documentSetItems: [],
      documentSetComplete: true,
      artifactVersionId: null,
    })
    vi.mocked(extractByLlm).mockResolvedValue(null)

    const result = await runReprocess({ country: 'de', batch: true })

    expect(result).toMatchObject({ processed: 1, llmCalls: 1 })
    expect(submitLlmBatch).not.toHaveBeenCalled()
    // Handed the input the batch path already built rather than rebuilding it:
    // preparing the document set downloads every archived blob and re-renders
    // scanned PDF pages, and this fall-through is the normal case for a
    // text-only batch provider (every auction carrying photos or a scan).
    expect(prepareArchivedLlmDocuments).toHaveBeenCalledTimes(1)
    expect(extractByLlm).toHaveBeenCalledWith(
      expect.objectContaining({ pdfPageImages: ['base64page1'] }),
      expect.anything(),
      expect.anything(),
    )
  })
})

// WP-3 SE root cause: record.auction is reconstructed from a LEFT JOIN
// LATERAL onto auction_details (auction-record.ts) — for an identity with no
// auction_details row yet (detailsId null; e.g. a fresh identity, or one
// whose details were wiped by rebuildCountry), every crawl-owned field on it
// is null/0 even though the crawler found real data, because this task never
// crawls live. Confirmed on prod: 96/96 se-kronofogden auctions got a v1
// auction_details row with address/description/market_value/photo_count all
// empty, while the artifact_captures snapshot archived minutes earlier for
// the same identities had the full crawled address, price and photos.
describe('runReprocess crawl-owned field recovery (WP-3 SE root cause)', () => {
  it('seeds address/description/price/photos from the archived capture on the very first auction_details row', async () => {
    vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map([['zvg-portal:7265', {
      auction: {
        ...auction(),
        address: null,
        description: null,
        marketValue: null,
        marketValueText: null,
        photoCount: 0,
        thumbnailUrl: null,
      },
      detailsId: null,
      detailsVersion: null,
      artifactVersionId: null,
    }]]))
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify({
      ...auction(),
      address: 'Ringvägen 65, 932 61 Lövånger',
      description: 'Fastighet bebyggd med ett bostadshus.',
      marketValue: 400000,
      marketValueText: '400000:- SEK',
      photoCount: 5,
      thumbnailUrl: 'https://auktionstorget.kronofogden.se/images/1.jpg',
    })))

    await expect(runReprocess({ country: 'de' })).resolves.toMatchObject({ processed: 1 })

    expect(writeAuctionDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        address: 'Ringvägen 65, 932 61 Lövånger',
        description: 'Fastighet bebyggd med ett bostadshus.',
        marketValue: 400000,
        marketValueText: '400000:- SEK',
        photoCount: 5,
        thumbnailUrl: 'https://auktionstorget.kronofogden.se/images/1.jpg',
      }),
      expect.anything(),
      { artifactVersionId: null },
    )
  })

  it('does not let a stale archived capture overwrite an auction_details row that already exists', async () => {
    vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map([['zvg-portal:7265', {
      auction: { ...auction(), address: 'Real DB address 1', photoCount: 3 },
      detailsId: 7,
      detailsVersion: 2,
      artifactVersionId: null,
    }]]))
    vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify({
      ...auction(),
      address: 'Outdated archived address',
      photoCount: 0,
    })))

    await expect(runReprocess({ country: 'de' })).resolves.toMatchObject({ processed: 1 })

    expect(writeAuctionDetails).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'Real DB address 1', photoCount: 3 }),
      expect.anything(),
      expect.anything(),
    )
  })
})
