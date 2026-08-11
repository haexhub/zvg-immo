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
import { extractByLlm, isLlmProviderUnavailable } from '../utils/extract/llm'
import { prepareArchivedLlmDocuments } from '../utils/extract/llm-documents'
import { writeAuctionDetails } from '../utils/auction-details'
import { upsertCurrentAuctions } from '../utils/current-auctions'
import { recordTaskRunError } from '../utils/task-run-errors'
import { recordLlmUsage } from '../utils/llm-usage'

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
  LLM_FAILURE_RETRY_COOLDOWN_HOURS: 24,
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
vi.mock('../utils/task-run-errors', () => ({
  recordTaskRunError: vi.fn(),
}))
vi.mock('../utils/llm-usage', () => ({
  recordLlmUsage: vi.fn(),
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
      llmConfigUsed: null,
      llmDurationMs: null,
    })
  })

  it('records the fallback config that actually answered, not the primary', async () => {
    const primary = { baseUrl: 'https://api.example.test', apiKey: 'k1', model: 'primary-model', provider: 'openai-compatible' as const }
    const fallback = {
      baseUrl: 'https://api.example.test', apiKey: 'k2', model: 'fallback-model', provider: 'openai-compatible' as const, profileId: 'profile-2',
    }
    vi.mocked(isLlmProviderUnavailable).mockReturnValueOnce(true)
    vi.mocked(extractByLlm)
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockImplementationOnce(async (_input, _config, opts) => {
        opts?.onProviderAttempt?.()
        return null
      })

    const result = await reprocessAuction(
      'zvg-portal',
      '7265',
      undefined,
      primary,
      '2026-08-02T11:00:00.000Z',
      { artifactState: emptyArtifactState, fallbackConfigs: [fallback] },
    )

    expect(result?.llmConfigUsed).toEqual(fallback)
    expect(result?.llmDurationMs).toEqual(expect.any(Number))
  })

  it('leaves provenance empty when extraction bailed out before any provider request', async () => {
    // extractByLlm returns null *without* calling onProviderAttempt when the
    // archived snapshot yields no parts at all — attributing that rules-only
    // version to a model that was never asked would misreport it.
    const config = { baseUrl: 'https://api.example.test', apiKey: 'k', model: 'never-asked', provider: 'openai-compatible' as const }
    vi.mocked(extractByLlm).mockResolvedValue(null)

    const result = await reprocessAuction(
      'zvg-portal',
      '7265',
      undefined,
      config,
      '2026-08-02T11:00:00.000Z',
      { artifactState: emptyArtifactState },
    )

    expect(result?.llmConfigUsed).toBeNull()
    expect(result?.llmDurationMs).toBeNull()
  })
})

describe('runReprocess structured persistence', () => {
  it('does not re-run a successful extraction merely because optional LLM fields are absent', async () => {
    const prior = extraction({
      llmAnalyzedAt: '2026-08-02T10:00:00.000Z',
      // Deliberately no condition/features/insights/etc.: these are valid
      // optional omissions in a model response, not unfinished work.
    })
    vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map([['zvg-portal:7265', {
      auction: { ...auction(), extraction: prior },
      detailsId: 7,
      detailsVersion: 2,
      artifactVersionId: null,
    }]]))
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{
      baseUrl: 'https://api.example.test', apiKey: 'secret', model: 'vision-model', provider: 'gemini-native',
    }])

    await expect(runReprocess({ country: 'de' })).resolves.toMatchObject({ processed: 0, skipped: 1, llmCalls: 0 })

    expect(extractByLlm).not.toHaveBeenCalled()
    expect(writeAuctionDetails).not.toHaveBeenCalled()
  })

  it('persists a synchronous rules result before updating the current projection', async () => {
    await expect(runReprocess({ country: 'de' })).resolves.toMatchObject({ processed: 1, skipped: 0 })

    expect(writeAuctionDetails).toHaveBeenCalledWith(
      expect.objectContaining({ extraction: expect.objectContaining({ source: 'rules' }) }),
      expect.objectContaining({ source: 'rules' }),
      {
        artifactVersionId: null,
        llmProvider: null,
        llmModel: null,
        llmProfileId: null,
        runTrigger: 'cron',
        llmDurationMs: null,
      },
    )
    expect(writeAuctionLlmPipelineState).toHaveBeenCalledWith('zvg-portal', '7265', {
      llmBatchJob: null,
      llmArtifactVersionId: null,
      llmFailures: 0,
      llmAttempted: false,
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
      llmArtifactVersionId: null, llmFailures: 2, llmLastAttemptedAt: null, photosCheckedAt: null,
      photoFailures: 0, photoLastAttemptedAt: null, photoPipelineVersion: null,
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
      {
        artifactVersionId: 11,
        llmProvider: null,
        llmModel: null,
        llmProfileId: null,
        runTrigger: 'cron',
        llmDurationMs: null,
      },
    )
    expect(writeAuctionLlmPipelineState).toHaveBeenLastCalledWith('zvg-portal', '7265', {
      llmBatchJob: 'batch-22',
      llmArtifactVersionId: 22,
      llmFailures: 2,
      llmAttempted: true,
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

  it("records the winning model's provenance, run trigger and duration on the written version", async () => {
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{
      baseUrl: 'https://api.example.test', apiKey: 'secret', model: 'vision-model', provider: 'gemini-native', profileId: 'profile-a',
    }])
    vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
      opts?.onProviderAttempt?.()
      return null
    })

    await expect(runReprocess({ country: 'de', trigger: 'manual' })).resolves.toMatchObject({ processed: 1 })

    expect(writeAuctionDetails).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        llmProvider: 'gemini-native',
        llmModel: 'vision-model',
        llmProfileId: 'profile-a',
        runTrigger: 'manual',
        llmDurationMs: expect.any(Number),
      }),
    )
  })

  it('records token usage/cost for the winning model when the provider reports it', async () => {
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{
      baseUrl: 'https://api.example.test', apiKey: 'secret', model: 'vision-model', provider: 'gemini-native', profileId: 'profile-a',
    }])
    vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
      opts?.onProviderAttempt?.()
      opts?.onUsage?.({ inputTokens: 800, outputTokens: 120 })
      return null
    })

    await expect(runReprocess({ country: 'de', trigger: 'manual' })).resolves.toMatchObject({ processed: 1 })

    expect(recordLlmUsage).toHaveBeenCalledWith({
      task: 'extraction',
      executionMode: 'sync',
      source: 'reprocess',
      provider: 'gemini-native',
      model: 'vision-model',
      profileId: 'profile-a',
      platform: 'zvg-portal',
      externalId: '7265',
      usage: { inputTokens: 800, outputTokens: 120 },
      status: 'failed',
      errorMessage: 'Keine gültige Extraktion in der Provider-Antwort',
      durationMs: expect.any(Number),
    })
  })

  it('records a failed call even when the provider did not report token counts', async () => {
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{
      baseUrl: 'https://api.example.test', apiKey: 'secret', model: 'vision-model', provider: 'gemini-native', profileId: 'profile-a',
    }])
    vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
      opts?.onProviderAttempt?.()
      return null
    })

    await expect(runReprocess({ country: 'de', trigger: 'manual' })).resolves.toMatchObject({ processed: 1 })

    expect(recordLlmUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: null,
      status: 'failed',
      errorMessage: 'Keine gültige Extraktion in der Provider-Antwort',
    }))
  })
})

describe('runReprocess llm_failures cooldown', () => {
  function lockedOutFetchState(llmLastAttemptedAt: string | null) {
    return new Map([['zvg-portal:7265', {
      platform: 'zvg-portal', externalId: '7265', pdfUrl: null, pdfUrlUpstream: null,
      detailUrl: null, detailUrlUpstream: null, attachments: [], photoUrls: null,
      sourceUpdatedIso: null, detailFetchedAt: null, llmBatchJob: null,
      llmArtifactVersionId: null, llmFailures: 3, llmLastAttemptedAt, photosCheckedAt: null,
      photoFailures: 0, photoLastAttemptedAt: null, photoPipelineVersion: null,
      updatedAt: '2026-08-02T10:00:00.000Z',
    }]])
  }

  it('stays locked out within the cooldown window after MAX_LLM_FAILURES', async () => {
    vi.mocked(readAuctionFetchStates).mockResolvedValue(
      lockedOutFetchState(new Date(Date.now() - 60 * 60 * 1000).toISOString()), // 1h ago
    )

    await expect(runReprocess({ country: 'de' })).resolves.toMatchObject({ processed: 0, skipped: 1 })
    expect(writeAuctionLlmPipelineState).not.toHaveBeenCalled()
  })

  it('ignoreCooldown bypasses the lockout immediately, without waiting for the 24h window', async () => {
    vi.mocked(readAuctionFetchStates).mockResolvedValue(
      lockedOutFetchState(new Date(Date.now() - 60 * 60 * 1000).toISOString()), // 1h ago — still locked normally
    )

    await expect(runReprocess({ country: 'de', ignoreCooldown: true })).resolves.toMatchObject({ processed: 1, skipped: 0 })
  })

  it('becomes eligible again once the cooldown has elapsed', async () => {
    vi.mocked(readAuctionFetchStates).mockResolvedValue(
      lockedOutFetchState(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()), // 25h ago
    )

    await expect(runReprocess({ country: 'de' })).resolves.toMatchObject({ processed: 1, skipped: 0 })
  })

  it('treats a never-attempted timestamp as elapsed (rows predating this column)', async () => {
    vi.mocked(readAuctionFetchStates).mockResolvedValue(lockedOutFetchState(null))

    await expect(runReprocess({ country: 'de' })).resolves.toMatchObject({ processed: 1, skipped: 0 })
  })

  it('records the attempt when a cooldown-triggered retry throws instead of resolving to null', async () => {
    // isLlmProviderUnavailable is mocked to false above, so reprocessAuction's
    // per-config loop always rethrows immediately — the same shape a real
    // rate-limit/unparseable-response error takes once it's the last
    // configured model. That propagates past persistEntry entirely, so
    // without the catch-block fix the cooldown timestamp would never
    // advance and this record would retry every run instead of once/24h.
    vi.mocked(readAuctionFetchStates).mockResolvedValue(
      lockedOutFetchState(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()), // past cooldown
    )
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{
      baseUrl: 'https://api.example.test', apiKey: 'secret', model: 'test-model', provider: 'openai-compatible',
    }])
    vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
      opts?.onProviderAttempt?.()
      throw new Error('provider unavailable')
    })

    await expect(runReprocess({ country: 'de' })).resolves.toMatchObject({ processed: 0, skipped: 1 })

    expect(writeAuctionLlmPipelineState).toHaveBeenCalledWith('zvg-portal', '7265', {
      llmBatchJob: null,
      llmArtifactVersionId: null,
      llmFailures: 3,
      llmAttempted: true,
    })
    expect(recordTaskRunError).toHaveBeenCalledWith('reprocess', {
      platform: 'zvg-portal',
      externalId: '7265',
      category: 'llm',
      message: 'provider unavailable',
    })
  })

  it('failedOnly skips an open candidate below MAX_LLM_FAILURES even though it would otherwise be eligible', async () => {
    // Default beforeEach state: no fetch state at all, i.e. llm_failures=0 —
    // the country's ordinary open/never-attempted bucket, not 'error'. The
    // /settings "Retry failed" action must never touch this (see
    // reprocess-retry-failed.post.ts).
    await expect(runReprocess({ country: 'de', failedOnly: true, ignoreCooldown: true }))
      .resolves.toMatchObject({ processed: 0, skipped: 1 })
  })

  it('failedOnly still processes a genuinely locked-out candidate', async () => {
    vi.mocked(readAuctionFetchStates).mockResolvedValue(
      lockedOutFetchState(new Date(Date.now() - 60 * 60 * 1000).toISOString()), // 1h ago — locked without ignoreCooldown
    )

    await expect(runReprocess({ country: 'de', failedOnly: true, ignoreCooldown: true }))
      .resolves.toMatchObject({ processed: 1, skipped: 0 })
  })
})

describe('runReprocess task_run_errors categorization', () => {
  it('categorizes a persistEntry (DB write) failure as persist, not llm', async () => {
    vi.mocked(writeAuctionDetails).mockRejectedValue(new Error('connection terminated unexpectedly'))

    await expect(runReprocess({ country: 'de' })).resolves.toMatchObject({ processed: 1, skipped: 1 })

    expect(recordTaskRunError).toHaveBeenCalledWith('reprocess', {
      platform: 'zvg-portal',
      externalId: '7265',
      category: 'persist',
      message: 'connection terminated unexpectedly',
    })
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
      {
        artifactVersionId: null,
        llmProvider: null,
        llmModel: null,
        llmProfileId: null,
        runTrigger: 'cron',
        llmDurationMs: null,
      },
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
