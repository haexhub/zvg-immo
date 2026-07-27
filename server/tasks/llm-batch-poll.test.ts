import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction, AuctionExtraction } from '~/types/auction'
import { fetchLlmBatchResults, pollLlmBatch } from '../utils/extract/llm-batch'
import { deleteLlmBatchJob, listPendingLlmBatchJobs, markLlmBatchJobChecked, type LlmBatchJob } from '../utils/llm-batch-jobs'
import { readExtractionCache, writeExtractionCache } from '../utils/extraction-cache'
import { readAuctionSnapshot, writeAuctionSnapshot } from '../utils/auction-snapshot'

vi.mock('../utils/extract/llm-batch', () => ({ pollLlmBatch: vi.fn(), fetchLlmBatchResults: vi.fn() }))
vi.mock('../utils/llm-batch-jobs', () => ({
  listPendingLlmBatchJobs: vi.fn(),
  deleteLlmBatchJob: vi.fn(),
  markLlmBatchJobChecked: vi.fn(),
}))
vi.mock('../utils/extraction-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/extraction-cache')>()
  return { ...actual, readExtractionCache: vi.fn(), writeExtractionCache: vi.fn() }
})
vi.mock('../utils/auction-snapshot', () => ({ readAuctionSnapshot: vi.fn(), writeAuctionSnapshot: vi.fn() }))
vi.stubGlobal('defineTask', (def: unknown) => def)

const { runLlmBatchPoll } = await import('./llm-batch-poll')

function makeEntry(overrides: Partial<AuctionExtraction> = {}): AuctionExtraction {
  return {
    propertyType: null,
    landAreaSqm: null,
    livingAreaSqm: null,
    rooms: null,
    bedrooms: null,
    bathrooms: null,
    floor: null,
    bathroomHasTub: null,
    bathroomHasShower: null,
    heating: null,
    units: null,
    source: 'rules',
    confidence: 'low',
    at: '2026-07-23T00:00:00.000Z',
    llmBatchJob: 'batches/abc',
    ...overrides,
  }
}

function makeJob(overrides: Partial<LlmBatchJob> = {}): LlmBatchJob {
  return {
    jobName: 'batches/abc',
    source: 'enrich',
    status: 'pending',
    itemCount: 1,
    customIdMap: {},
    submittedAt: '2026-07-26T18:00:00.000Z',
    checkedAt: null,
    updatedAt: '2026-07-26T18:00:00.000Z',
    ...overrides,
  }
}

function makeAuction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'zvg-portal',
    country: 'de',
    region: 'Sachsen',
    externalId: '7265',
    caseNumber: '12 K 34/26',
    authority: 'AG Musterstadt',
    title: null,
    address: 'Musterstraße 1, 01234 Musterstadt',
    marketValueEur: 100_000,
    marketValueText: '100.000 EUR',
    auctionDateIso: '2026-08-01T09:00:00.000Z',
    auctionDateText: '01.08.2026',
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

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({
    extractLlm: {
      baseUrl: 'http://gemini',
      provider: 'gemini-native',
      geminiBatchTier: 'free',
      geminiFreeBatchPollIntervalHours: 6,
    },
  }))
  vi.mocked(readExtractionCache).mockResolvedValue({})
  vi.mocked(readAuctionSnapshot).mockResolvedValue({})
  vi.mocked(writeExtractionCache).mockResolvedValue(true)
  vi.mocked(writeAuctionSnapshot).mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('runLlmBatchPoll', () => {
  it('does nothing when there are no pending jobs', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([])

    const result = await runLlmBatchPoll()

    expect(result).toEqual({ checked: 0, merged: 0 })
    expect(pollLlmBatch).not.toHaveBeenCalled()
  })

  it('skips without an LLM provider configured, even with pending jobs', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: {} }))
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([makeJob()])

    const result = await runLlmBatchPoll()

    expect(result).toEqual({ checked: 0, merged: 0 })
    expect(pollLlmBatch).not.toHaveBeenCalled()
  })

  it('leaves a still-pending job untouched', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([makeJob()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'pending' })

    const result = await runLlmBatchPoll()

    expect(result).toEqual({ checked: 1, merged: 0 })
    expect(markLlmBatchJobChecked).toHaveBeenCalledWith('batches/abc', expect.any(String))
    expect(deleteLlmBatchJob).not.toHaveBeenCalled()
    expect(fetchLlmBatchResults).not.toHaveBeenCalled()
  })

  it('skips a recently checked Gemini job while in the free-tier poll interval', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([
      makeJob({ checkedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
    ])

    const result = await runLlmBatchPoll()

    expect(result).toEqual({ checked: 0, merged: 0 })
    expect(pollLlmBatch).not.toHaveBeenCalled()
    expect(markLlmBatchJobChecked).not.toHaveBeenCalled()
  })

  it('deletes the job row on failed/expired without touching the cache', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([makeJob()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'failed' })

    const result = await runLlmBatchPoll()

    expect(result).toEqual({ checked: 1, merged: 0 })
    expect(deleteLlmBatchJob).toHaveBeenCalledWith('batches/abc')
    expect(writeExtractionCache).not.toHaveBeenCalled()
  })

  it('merges a succeeded job into extraction_cache and auction_snapshot, then deletes the job row', async () => {
    const priorEntry = makeEntry({ propertyType: 'einfamilienhaus', landAreaSqm: 500, confidence: 'high' })
    vi.mocked(readExtractionCache).mockResolvedValue({ 'zvg-portal:7265': priorEntry })
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([makeJob()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'succeeded', resultFileName: 'files/results' })
    vi.mocked(fetchLlmBatchResults).mockResolvedValue([
      {
        key: 'zvg-portal:7265',
        extraction: {
          propertyType: null,
          landAreaSqm: null,
          livingAreaSqm: null,
          rooms: null,
          bedrooms: null,
          bathrooms: null,
          floor: null,
          bathroomHasTub: null,
          bathroomHasShower: null,
          heating: null,
          units: null,
          securityDeposit: null,
          biddingNotes: null,
          condition: 'gepflegt',
          features: [],
          yearBuilt: 1998,
          lastRenovationYear: null,
          renovationNotes: null,
          insights: null,
          planningNotes: null,
          photoCuration: [],
          marketValueEur: null,
          marketValueText: null,
        },
      },
    ])
    const auction = makeAuction()
    vi.mocked(readAuctionSnapshot).mockResolvedValue({ 'zvg-portal:7265': auction })

    const result = await runLlmBatchPoll()

    expect(result).toEqual({ checked: 1, merged: 1 })
    expect(fetchLlmBatchResults).toHaveBeenCalledWith('batches/abc', 'files/results', expect.any(Object), {})
    expect(writeExtractionCache).toHaveBeenCalledWith({
      'zvg-portal:7265': expect.objectContaining({ condition: 'gepflegt', yearBuilt: 1998, propertyType: 'einfamilienhaus' }),
    })
    // Confident propertyType/area came from rules — untouched by the LLM.
    const [written] = vi.mocked(writeExtractionCache).mock.calls[0]!
    expect(written['zvg-portal:7265']!.llmBatchJob).toBeUndefined()
    expect(writeAuctionSnapshot).toHaveBeenCalledTimes(1)
    expect(deleteLlmBatchJob).toHaveBeenCalledWith('batches/abc')
  })

  it('leaves the job row in place when writing the cache fails, so the next tick retries', async () => {
    const priorEntry = makeEntry({ propertyType: 'einfamilienhaus', landAreaSqm: 500, confidence: 'high' })
    vi.mocked(readExtractionCache).mockResolvedValue({ 'zvg-portal:7265': priorEntry })
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([makeJob()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'succeeded', resultFileName: 'files/results' })
    vi.mocked(fetchLlmBatchResults).mockResolvedValue([
      {
        key: 'zvg-portal:7265',
        extraction: {
          propertyType: null,
          landAreaSqm: null,
          livingAreaSqm: null,
          rooms: null,
          bedrooms: null,
          bathrooms: null,
          floor: null,
          bathroomHasTub: null,
          bathroomHasShower: null,
          heating: null,
          units: null,
          securityDeposit: null,
          biddingNotes: null,
          condition: 'gepflegt',
          features: [],
          yearBuilt: 1998,
          lastRenovationYear: null,
          renovationNotes: null,
          insights: null,
          planningNotes: null,
          photoCuration: [],
          marketValueEur: null,
          marketValueText: null,
        },
      },
    ])
    vi.mocked(writeExtractionCache).mockResolvedValue(false)

    const result = await runLlmBatchPoll()

    expect(result).toEqual({ checked: 1, merged: 1 })
    expect(writeAuctionSnapshot).not.toHaveBeenCalled()
    expect(deleteLlmBatchJob).not.toHaveBeenCalled()
  })

  it('skips a result whose key has no cached prior entry', async () => {
    vi.mocked(readExtractionCache).mockResolvedValue({})
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([makeJob()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'succeeded', resultFileName: 'files/results' })
    vi.mocked(fetchLlmBatchResults).mockResolvedValue([{ key: 'zvg-portal:unknown', extraction: null }])

    const result = await runLlmBatchPoll()

    expect(result).toEqual({ checked: 1, merged: 0 })
    expect(writeExtractionCache).not.toHaveBeenCalled()
    expect(deleteLlmBatchJob).toHaveBeenCalledWith('batches/abc')
  })

  it('continues with other jobs when one job throws', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([
      makeJob({ jobName: 'batches/bad' }),
      makeJob({ jobName: 'batches/good' }),
    ])
    vi.mocked(pollLlmBatch).mockImplementation(async (jobName) => {
      if (jobName === 'batches/bad') throw new Error('boom')
      return { state: 'failed' }
    })

    const result = await runLlmBatchPoll()

    expect(result).toEqual({ checked: 2, merged: 0 })
    expect(deleteLlmBatchJob).toHaveBeenCalledWith('batches/good')
    expect(deleteLlmBatchJob).not.toHaveBeenCalledWith('batches/bad')
  })
})
