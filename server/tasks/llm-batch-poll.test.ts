import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction, AuctionExtraction } from '~/types/auction'
import { fetchLlmBatchResults, pollLlmBatch } from '../utils/extract/llm-batch'
import { readExtractionLlmConfig } from '../utils/extract/llm-task-config'
import { readAuctionRecordMap } from '../utils/auction-record'
import { readAuctionFetchStates, writeAuctionLlmPipelineState } from '../utils/auction-fetch-state'
import { upsertCurrentAuctions } from '../utils/current-auctions'
import { writeAuctionDetails } from '../utils/auction-details'
import {
  listPendingLlmBatchJobs,
  markLlmBatchJobChecked,
  markLlmBatchJobResolved,
  type LlmBatchJob,
} from '../utils/llm-batch-jobs'

vi.mock('../utils/extract/llm-batch', () => ({ pollLlmBatch: vi.fn(), fetchLlmBatchResults: vi.fn() }))
vi.mock('../utils/extract/llm-task-config', () => ({ readExtractionLlmConfig: vi.fn() }))
vi.mock('../utils/auction-record', () => ({ readAuctionRecordMap: vi.fn() }))
vi.mock('../utils/auction-fetch-state', () => ({
  readAuctionFetchStates: vi.fn(),
  writeAuctionLlmPipelineState: vi.fn(),
}))
vi.mock('../utils/current-auctions', () => ({ upsertCurrentAuctions: vi.fn() }))
vi.mock('../utils/auction-details', () => ({ writeAuctionDetails: vi.fn() }))
vi.mock('../utils/llm-batch-jobs', () => ({
  listPendingLlmBatchJobs: vi.fn(),
  markLlmBatchJobChecked: vi.fn(),
  markLlmBatchJobResolved: vi.fn(),
}))
vi.stubGlobal('defineTask', (definition: unknown) => definition)

const { runLlmBatchPoll } = await import('./llm-batch-poll')

function entry(overrides: Partial<AuctionExtraction> = {}): AuctionExtraction {
  return {
    propertyType: 'einfamilienhaus',
    landAreaSqm: 500,
    livingAreaSqm: 120,
    rooms: 4,
    units: 1,
    source: 'rules',
    confidence: 'high',
    at: '2026-08-02T10:00:00.000Z',
    ...overrides,
  }
}

function auction(extraction: AuctionExtraction = entry()): Auction {
  return {
    platform: 'zvg-portal',
    country: 'de',
    region: 'Sachsen',
    externalId: '7265',
    caseNumber: '12 K 34/26',
    authority: 'AG Musterstadt',
    title: 'Einfamilienhaus',
    address: 'Musterstraße 1, 01234 Musterstadt',
    marketValueEur: 100000,
    marketValueText: '100.000 EUR',
    auctionDateIso: '2026-09-01T09:00:00.000Z',
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
    extraction,
  }
}

function job(overrides: Partial<LlmBatchJob> = {}): LlmBatchJob {
  return {
    jobName: 'batches/abc',
    source: 'reprocess',
    status: 'pending',
    itemCount: 1,
    customIdMap: {},
    submittedAt: '2026-08-02T10:00:00.000Z',
    checkedAt: null,
    updatedAt: '2026-08-02T10:00:00.000Z',
    errorMessage: null,
    ...overrides,
  }
}

const llmResult = {
  propertyType: null,
  landAreaSqm: null,
  livingAreaSqm: null,
  rooms: null,
  bedrooms: 3,
  bathrooms: 1,
  floor: null,
  bathroomHasTub: true,
  bathroomHasShower: false,
  heating: 'Gas',
  units: null,
  securityDeposit: null,
  biddingNotes: null,
  condition: 'gepflegt' as const,
  features: [],
  yearBuilt: 1998,
  lastRenovationYear: null,
  renovationNotes: null,
  insights: null,
  planningNotes: null,
  photoCuration: [],
  marketValueEur: null,
  marketValueText: null,
}

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({
    extractLlm: { geminiBatchTier: 'paid' },
  }))
  vi.mocked(readExtractionLlmConfig).mockResolvedValue({
    baseUrl: 'https://example.test',
    apiKey: 'test',
    model: 'gemini-test',
    provider: 'gemini-native',
  })
  const stored = auction()
  vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map([['zvg-portal:7265', {
    auction: stored,
    detailsId: 7,
    detailsVersion: 2,
    artifactVersionId: 11,
  }]]))
  vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map([['zvg-portal:7265', {
    platform: 'zvg-portal',
    externalId: '7265',
    pdfUrl: null,
    pdfUrlUpstream: null,
    detailUrl: null,
    detailUrlUpstream: null,
    attachments: [],
    photoUrls: null,
    sourceUpdatedIso: null,
    detailFetchedAt: null,
    llmBatchJob: 'batches/abc',
    llmArtifactVersionId: 22,
    llmFailures: 2,
    photosCheckedAt: null,
    photoFailures: 0,
    photoPipelineVersion: null,
    updatedAt: '2026-08-02T10:00:00.000Z',
  }]]))
  vi.mocked(writeAuctionDetails).mockResolvedValue({ version: 3, changed: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('runLlmBatchPoll', () => {
  it('does nothing without pending jobs', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([])
    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 0, merged: 0 })
    expect(pollLlmBatch).not.toHaveBeenCalled()
  })

  it('skips pending jobs without an LLM configuration', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job()])
    vi.mocked(readExtractionLlmConfig).mockResolvedValue(null)
    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 0, merged: 0 })
    expect(pollLlmBatch).not.toHaveBeenCalled()
  })

  it('checks a still-pending job without resolving it', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'pending' })
    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 1, merged: 0 })
    expect(markLlmBatchJobChecked).toHaveBeenCalledWith('batches/abc', expect.any(String))
    expect(markLlmBatchJobResolved).not.toHaveBeenCalled()
  })

  it('resolves a failed job without changing auction data', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'failed', errorMessage: 'provider failed' })
    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 1, merged: 0 })
    expect(markLlmBatchJobResolved).toHaveBeenCalledWith(
      'batches/abc', 'failed', expect.any(String), 'provider failed',
    )
    expect(writeAuctionDetails).not.toHaveBeenCalled()
  })

  it('writes a successful result to details and clears its fetch-state marker', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'succeeded', resultFileName: 'files/result' })
    vi.mocked(fetchLlmBatchResults).mockResolvedValue([
      { key: 'zvg-portal:7265', extraction: llmResult },
    ])

    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 1, merged: 1 })
    expect(writeAuctionDetails).toHaveBeenCalledWith(
      expect.objectContaining({ extraction: expect.objectContaining({ condition: 'gepflegt', yearBuilt: 1998 }) }),
      expect.objectContaining({ condition: 'gepflegt', yearBuilt: 1998 }),
      { artifactVersionId: 22 },
    )
    expect(upsertCurrentAuctions).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeAuctionDetails).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(upsertCurrentAuctions).mock.invocationCallOrder[0]!)
    expect(writeAuctionLlmPipelineState).toHaveBeenCalledWith('zvg-portal', '7265', {
      llmBatchJob: null,
      llmArtifactVersionId: null,
      llmFailures: 0,
    })
    expect(markLlmBatchJobResolved).toHaveBeenCalledWith('batches/abc', 'succeeded', expect.any(String))
  })

  it('keeps a succeeded job pending when writing structured details fails', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'succeeded', resultFileName: 'files/result' })
    vi.mocked(fetchLlmBatchResults).mockResolvedValue([
      { key: 'zvg-portal:7265', extraction: llmResult },
    ])
    vi.mocked(writeAuctionDetails).mockRejectedValue(new Error('database unavailable'))

    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 1, merged: 0 })
    expect(markLlmBatchJobResolved).not.toHaveBeenCalled()
    expect(writeAuctionLlmPipelineState).not.toHaveBeenCalled()
    expect(upsertCurrentAuctions).not.toHaveBeenCalled()
  })

  it('increments failures and clears state for a null batch extraction', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'succeeded', resultFileName: 'files/result' })
    vi.mocked(fetchLlmBatchResults).mockResolvedValue([
      { key: 'zvg-portal:7265', extraction: null },
    ])

    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 1, merged: 1 })
    expect(writeAuctionLlmPipelineState).toHaveBeenCalledWith('zvg-portal', '7265', {
      llmBatchJob: null,
      llmArtifactVersionId: null,
      llmFailures: 3,
    })
  })

  it('continues after one job throws', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([
      job({ jobName: 'batches/bad' }),
      job({ jobName: 'batches/good' }),
    ])
    vi.mocked(pollLlmBatch).mockImplementation(async (name) => {
      if (name === 'batches/bad') throw new Error('boom')
      return { state: 'expired' }
    })

    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 2, merged: 0 })
    expect(markLlmBatchJobResolved).toHaveBeenCalledWith('batches/good', 'expired', expect.any(String), null)
  })
})
