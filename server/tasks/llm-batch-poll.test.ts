import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction, AuctionExtraction } from '~/types/auction'
import { fetchLlmBatchResults, pollLlmBatch } from '../utils/extract/llm-batch'
import { readExtractionLlmConfig, resolveLlmConfigForProfile } from '../utils/extract/llm-task-config'
import { readAuctionRecordMap } from '../utils/auction-record'
import { readAuctionFetchStates, writeAuctionLlmPipelineState, type AuctionFetchState } from '../utils/auction-fetch-state'
import { upsertCurrentAuctions } from '../utils/current-auctions'
import { writeAuctionDetails } from '../utils/auction-details'
import {
  listPendingLlmBatchJobs,
  markLlmBatchJobChecked,
  markLlmBatchJobResolved,
  type LlmBatchJob,
} from '../utils/llm-batch-jobs'
import { recordLlmUsage } from '../utils/llm-usage'
import { getPool } from '../utils/db'
import { recordTaskRunError } from '../utils/task-run-errors'

vi.mock('../utils/extract/llm-batch', () => ({
  pollLlmBatch: vi.fn(),
  fetchLlmBatchResults: vi.fn(),
  LLM_BATCH_JOB_EXPIRY_MS: 48 * 60 * 60 * 1000,
}))
vi.mock('../utils/extract/llm-task-config', () => ({
  readExtractionLlmConfig: vi.fn(),
  resolveLlmConfigForProfile: vi.fn(),
}))
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
vi.mock('../utils/llm-usage', () => ({ recordLlmUsage: vi.fn() }))
vi.mock('../utils/db', () => ({ getPool: vi.fn() }))
vi.mock('../utils/task-run-errors', () => ({ recordTaskRunError: vi.fn() }))
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

function fetchState(overrides: Partial<AuctionFetchState> = {}): AuctionFetchState {
  return {
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
    enrichClaimedAt: null,
    llmBatchJob: 'batches/abc',
    llmArtifactVersionId: 22,
    llmRulesHint: null,
    llmFailures: 2,
    llmLastAttemptedAt: null,
    llmClaimedAt: null,
    photosCheckedAt: null,
    photoFailures: 0,
    photoLastAttemptedAt: null,
    photoPipelineVersion: null,
    updatedAt: '2026-08-02T10:00:00.000Z',
    ...overrides,
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
    provider: null,
    model: null,
    profileId: null,
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
  ruleCheck: null,
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
  vi.mocked(getPool).mockReturnValue({} as never)
  const stored = auction()
  vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map([['zvg-portal:7265', {
    auction: stored,
    detailsId: 7,
    detailsVersion: 2,
    artifactVersionId: 11,
  }]]))
  vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map([['zvg-portal:7265', fetchState()]]))
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

  it('resolves a failed job without changing auction data and logs each item as failed', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job({
      provider: 'openrouter',
      model: 'google/gemini-3.5-flash-lite:batch',
      profileId: 'profile-a',
      customIdMap: { c1: 'zvg-portal:7265' },
    })])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'failed', errorMessage: 'provider failed' })
    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 1, merged: 0 })
    expect(markLlmBatchJobResolved).toHaveBeenCalledWith(
      'batches/abc', 'failed', expect.any(String), 'provider failed',
    )
    expect(writeAuctionDetails).not.toHaveBeenCalled()
    expect(recordLlmUsage).toHaveBeenCalledWith({
      task: 'extraction',
      executionMode: 'batch',
      source: 'reprocess',
      provider: 'openrouter',
      model: 'google/gemini-3.5-flash-lite:batch',
      profileId: 'profile-a',
      platform: 'zvg-portal',
      externalId: '7265',
      usage: null,
      status: 'failed',
      errorMessage: 'provider failed',
      batchJobName: 'batches/abc',
    })
  })

  it('writes a successful result to details and clears its fetch-state marker', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'succeeded', resultFileName: 'files/result' })
    vi.mocked(fetchLlmBatchResults).mockResolvedValue([
      { key: 'zvg-portal:7265', extraction: llmResult, usage: null },
    ])

    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 1, merged: 1 })
    expect(writeAuctionDetails).toHaveBeenCalledWith(
      expect.objectContaining({ extraction: expect.objectContaining({ condition: 'gepflegt', yearBuilt: 1998 }) }),
      expect.objectContaining({ condition: 'gepflegt', yearBuilt: 1998 }),
      { artifactVersionId: 22, llmProvider: null, llmModel: null, llmProfileId: null, runTrigger: 'cron' },
    )
    expect(upsertCurrentAuctions).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeAuctionDetails).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(upsertCurrentAuctions).mock.invocationCallOrder[0]!)
    expect(writeAuctionLlmPipelineState).toHaveBeenCalledWith('zvg-portal', '7265', {
      llmBatchJob: null,
      llmArtifactVersionId: null,
      llmRulesHint: null,
      llmFailures: 0,
    })
    expect(markLlmBatchJobResolved).toHaveBeenCalledWith('batches/abc', 'succeeded', expect.any(String))
    expect(recordLlmUsage).not.toHaveBeenCalled()
  })

  it('honours a ruleCheck verdict whose hinted value still matches at merge time', async () => {
    vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map([['zvg-portal:7265', fetchState({
      llmRulesHint: { propertyType: 'einfamilienhaus', rooms: null, units: null, securityDeposit: null },
    })]]))
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'succeeded', resultFileName: 'files/result' })
    vi.mocked(fetchLlmBatchResults).mockResolvedValue([
      {
        key: 'zvg-portal:7265',
        extraction: {
          ...llmResult,
          propertyType: 'eigentumswohnung',
          ruleCheck: { propertyType: false, rooms: null, units: null, securityDeposit: null },
        },
        usage: null,
      },
    ])

    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 1, merged: 1 })
    expect(writeAuctionDetails).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ propertyType: 'eigentumswohnung' }),
      expect.anything(),
    )
  })

  it('ignores a ruleCheck verdict about a value that changed since the batch was submitted', async () => {
    // A re-crawl between submit and poll: the model refuted 'mehrfamilienhaus',
    // but the rules pass now reads 'einfamilienhaus' off the current title.
    vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map([['zvg-portal:7265', fetchState({
      llmRulesHint: { propertyType: 'mehrfamilienhaus', rooms: null, units: null, securityDeposit: null },
    })]]))
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'succeeded', resultFileName: 'files/result' })
    vi.mocked(fetchLlmBatchResults).mockResolvedValue([
      {
        key: 'zvg-portal:7265',
        extraction: {
          ...llmResult,
          propertyType: 'eigentumswohnung',
          ruleCheck: { propertyType: false, rooms: null, units: null, securityDeposit: null },
        },
        usage: null,
      },
    ])

    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 1, merged: 1 })
    expect(writeAuctionDetails).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ propertyType: 'einfamilienhaus', source: 'rules' }),
      expect.anything(),
    )
  })

  it('skips a result whose item has meanwhile been re-submitted into another job', async () => {
    // Job 'batches/abc' only now recovered; the item's 48h marker was already
    // forgiven and it sits in a newer batch. Merging here would validate
    // against the newer job's snapshot and clear its pending marker.
    vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map([['zvg-portal:7265', fetchState({
      llmBatchJob: 'batches/newer',
    })]]))
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'succeeded', resultFileName: 'files/result' })
    vi.mocked(fetchLlmBatchResults).mockResolvedValue([
      { key: 'zvg-portal:7265', extraction: llmResult, usage: null },
    ])

    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 1, merged: 0 })
    expect(writeAuctionDetails).not.toHaveBeenCalled()
    expect(writeAuctionLlmPipelineState).not.toHaveBeenCalled()
  })

  it('records token usage against the job\'s submit-time provider/model, not the poll-time config', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([
      job({ provider: 'gemini-native', model: 'gemini-flash-latest', profileId: 'profile-a' }),
    ])
    vi.mocked(resolveLlmConfigForProfile).mockResolvedValue({
      baseUrl: 'https://profile-a.example', apiKey: 'profile-a-key', model: 'gemini-flash-latest', provider: 'gemini-native',
    })
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'succeeded', resultFileName: 'files/result' })
    vi.mocked(fetchLlmBatchResults).mockResolvedValue([
      { key: 'zvg-portal:7265', extraction: llmResult, usage: { inputTokens: 900, outputTokens: 200 } },
    ])

    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 1, merged: 1 })

    expect(writeAuctionDetails).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ llmProvider: 'gemini-native', llmModel: 'gemini-flash-latest', llmProfileId: 'profile-a' }),
    )
    expect(recordLlmUsage).toHaveBeenCalledWith({
      task: 'extraction',
      executionMode: 'batch',
      source: 'reprocess',
      provider: 'gemini-native',
      model: 'gemini-flash-latest',
      profileId: 'profile-a',
      platform: 'zvg-portal',
      externalId: '7265',
      usage: { inputTokens: 900, outputTokens: 200 },
      status: 'succeeded',
      errorMessage: null,
      batchJobName: 'batches/abc',
    })
  })

  it('polls and fetches with the job\'s own submit-time profile, not the current chain config', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([
      job({ provider: 'gemini-native', model: 'gemini-flash-latest', profileId: 'profile-a' }),
    ])
    const profileConfig = {
      baseUrl: 'https://profile-a.example', apiKey: 'profile-a-key', model: 'gemini-flash-latest', provider: 'gemini-native' as const,
    }
    vi.mocked(resolveLlmConfigForProfile).mockResolvedValue(profileConfig)
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'succeeded', resultFileName: 'files/result' })
    vi.mocked(fetchLlmBatchResults).mockResolvedValue([])

    await runLlmBatchPoll()

    expect(resolveLlmConfigForProfile).toHaveBeenCalledWith({}, 'profile-a')
    expect(pollLlmBatch).toHaveBeenCalledWith('batches/abc', { ...profileConfig, model: 'gemini-flash-latest' })
    expect(fetchLlmBatchResults).toHaveBeenCalledWith('batches/abc', 'files/result', { ...profileConfig, model: 'gemini-flash-latest' }, {})
  })

  it('falls back to the current chain config for a legacy job without a profile snapshot', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job({ profileId: null })])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'pending' })

    await runLlmBatchPoll()

    expect(resolveLlmConfigForProfile).not.toHaveBeenCalled()
    expect(pollLlmBatch).toHaveBeenCalledWith('batches/abc', {
      baseUrl: 'https://example.test', apiKey: 'test', model: 'gemini-test', provider: 'gemini-native',
    })
  })

  it('falls back to the current chain config when the job\'s profile no longer resolves', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job({ profileId: 'deleted-profile' })])
    vi.mocked(resolveLlmConfigForProfile).mockResolvedValue(null)
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'pending' })

    await runLlmBatchPoll()

    expect(pollLlmBatch).toHaveBeenCalledWith('batches/abc', {
      baseUrl: 'https://example.test', apiKey: 'test', model: 'gemini-test', provider: 'gemini-native',
    })
  })

  it('keeps a succeeded job pending when writing structured details fails', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job()])
    vi.mocked(pollLlmBatch).mockResolvedValue({ state: 'succeeded', resultFileName: 'files/result' })
    vi.mocked(fetchLlmBatchResults).mockResolvedValue([
      { key: 'zvg-portal:7265', extraction: llmResult, usage: null },
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
      { key: 'zvg-portal:7265', extraction: null, usage: null, error: 'provider rejected request' },
    ])

    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 1, merged: 1 })
    expect(writeAuctionLlmPipelineState).toHaveBeenCalledWith('zvg-portal', '7265', {
      llmBatchJob: null,
      llmArtifactVersionId: null,
      llmRulesHint: null,
      llmFailures: 3,
    })
    expect(recordTaskRunError).toHaveBeenCalledWith('reprocess', {
      category: 'llm',
      message: 'provider rejected request',
      platform: 'zvg-portal',
      externalId: '7265',
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

  it('gives up a job whose poll request keeps failing past the 48h grace window', async () => {
    // job()'s default submittedAt (2026-08-02) is far more than 48h before
    // any test run — a job stuck failing to even poll (deleted profile,
    // revoked key, ...) must eventually stop being retried forever.
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job()])
    vi.mocked(pollLlmBatch).mockRejectedValue(new Error('unauthorized'))

    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 1, merged: 0 })
    expect(markLlmBatchJobResolved).toHaveBeenCalledWith('batches/abc', 'expired', expect.any(String), 'unauthorized')
  })

  it('keeps retrying a job whose poll request fails within the 48h grace window', async () => {
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([
      job({ submittedAt: new Date().toISOString() }),
    ])
    vi.mocked(pollLlmBatch).mockRejectedValue(new Error('network blip'))

    await expect(runLlmBatchPoll()).resolves.toEqual({ checked: 1, merged: 0 })
    expect(markLlmBatchJobResolved).not.toHaveBeenCalled()
  })
})
