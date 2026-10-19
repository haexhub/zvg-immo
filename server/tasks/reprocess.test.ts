import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction, AuctionExtraction } from '~/types/auction'
import type { ClampedExtraction } from '../utils/extract/llm-clamp'
import type { ReprocessInput } from '../utils/tasks/reprocess-input'
import { downloadBlob, listDistinctCaptures } from '../utils/storage-download'
import { getPool } from '../utils/db'
import { readAuctionRecordMap } from '../utils/auction-record'
import { readAuctionFetchStates, writeAuctionLlmClaim, writeAuctionLlmPipelineState } from '../utils/auction-fetch-state'
import { readArtifactProcessingState } from '../utils/artifact-version-state'
import { readExtractionChainStrategy, readExtractionLlmConfigChain } from '../utils/extract/llm-task-config'
import { getLlmConcurrency, readLlmExecutionMode } from '../utils/app-settings'
import { isLlmBatchPending, submitLlmBatch } from '../utils/extract/llm-batch'
import { extractByLlm } from '../utils/extract/llm'
import { isLlmProviderUnavailable } from '../utils/extract/llm-errors'
import { prepareArchivedLlmDocuments } from '../utils/extract/llm-documents'
import { writeAuctionDetails } from '../utils/auction-details'
import { upsertCurrentAuctions } from '../utils/current-auctions'
import { recordTaskRunError } from '../utils/task-run-errors'
import { recordLlmUsage } from '../utils/llm-usage'
import { recordTaskRunProgress, recordTaskRunStart } from '../utils/task-runs'
import { isConnectionLostError, isLlmProviderError, isRateLimitError } from '../utils/extract/llm-errors'
import { waitForProviderRecovery } from '../utils/extract/provider-recovery'

vi.mock('../utils/storage-download', () => ({
  listDistinctCaptures: vi.fn(),
  downloadBlob: vi.fn(),
  readDocumentSet: vi.fn(async () => null),
}))
vi.mock('../utils/db', () => ({ getPool: vi.fn() }))
vi.mock('../utils/auction-record', () => {
  const readAuctionRecordMap = vi.fn()
  return {
    readAuctionRecordMap,
    // reprocess-run reads records per candidate chunk; serve it from the map each test prepares.
    createCandidateRecordLoader: () => ({
      get: async (platform: string, externalId: string) => (await readAuctionRecordMap()).get(`${platform}:${externalId}`),
    }),
  }
})
vi.mock('../utils/auction-fetch-state', () => ({
  readAuctionFetchStates: vi.fn(),
  writeAuctionLlmClaim: vi.fn(),
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
vi.mock('../utils/app-settings', () => ({ MAX_LLM_CONCURRENCY: 8, readLlmExecutionMode: vi.fn(), getLlmMaxPerRun: vi.fn(async () => null), getLlmConcurrency: vi.fn(async () => null) }))
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
}))
vi.mock('../utils/extract/provider-recovery', () => ({ waitForProviderRecovery: vi.fn(async () => false) }))
vi.mock('../utils/extract/llm-errors', () => ({
  isConnectionLostError: vi.fn(() => false),
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
vi.mock('../utils/automatic-task-gate', () => ({ isAutomaticLlmEnabled: vi.fn(async () => true) }))

vi.stubGlobal('defineTask', (definition: unknown) => definition)

const { reprocessAuction, runReprocess, runReprocessTask } = await import('./reprocess')
const { DOCUMENT_SUMMARY_SCHEMA_NAME } = await import('../utils/extract/llm-schema')

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
  vi.mocked(listDistinctCaptures).mockResolvedValue([{
    contentHash: 'auction-hash',
    sourceUrl: null,
    capturedAt: '2026-08-02T10:00:00.000Z',
  }])
  vi.mocked(downloadBlob).mockResolvedValue(Buffer.from(JSON.stringify(auction())))
  vi.mocked(writeAuctionDetails).mockResolvedValue({ version: 3, changed: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('reprocessAuction structured provenance', () => {
  it('returns null when no archived auction capture exists', async () => {
    vi.mocked(listDistinctCaptures).mockResolvedValue([])

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
    vi.mocked(listDistinctCaptures).mockResolvedValue([{
      contentHash: 'missing-blob',
      sourceUrl: null,
      capturedAt: '2026-08-02T10:00:00.000Z',
    }])
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
    vi.mocked(listDistinctCaptures).mockResolvedValue([{
      contentHash: 'auction-hash',
      sourceUrl: null,
      capturedAt: '2026-08-02T10:00:00.000Z',
    }])
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

  it('does not count an input with nothing to send as an LLM call or failure', async () => {
    const config = { baseUrl: 'https://api.example.test', apiKey: 'k', model: 'never-asked', provider: 'openai-compatible' as const }
    vi.mocked(extractByLlm).mockResolvedValue(null)

    const result = await reprocessAuction(
      'zvg-portal', '7265', undefined, config, '2026-08-02T11:00:00.000Z',
      { artifactState: emptyArtifactState, priorLlmFailures: 2 },
    )

    expect(result).toMatchObject({ llmCalled: false, llmInputEmpty: true, llmFailures: 2 })
  })
})

describe('reprocessAuction without an LLM result on a changed document set', () => {
  const changedSetState = {
    latest: { id: 22, platform: 'zvg-portal', externalId: '7265', version: 2, setHash: 'new-set' },
    parsedArtifactVersionId: 11,
  }
  const priorLlmEntry = extraction({
    condition: 'gepflegt',
    features: ['garten'],
    yearBuilt: 1936,
    marketValueEur: 250_000,
    documentSummary: 'Gutachten von 2025',
    llmAnalyzedAt: '2026-08-01T10:00:00.000Z',
  })

  it('keeps the prior LLM values when the LLM call fails', async () => {
    const config = { baseUrl: 'https://api.example.test', apiKey: 'k', model: 'test-model', provider: 'openai-compatible' as const }
    vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
      opts?.onProviderAttempt?.()
      return null
    })

    const result = await reprocessAuction(
      'zvg-portal', '7265', priorLlmEntry, config, '2026-08-02T11:00:00.000Z',
      { artifactState: changedSetState },
    )

    expect(result?.entry).toMatchObject({
      condition: 'gepflegt', features: ['garten'], yearBuilt: 1936, marketValueEur: 250_000,
      documentSummary: 'Gutachten von 2025', llmAnalyzedAt: '2026-08-01T10:00:00.000Z',
    })
    // Still unparsed, so a later run retries the new document set.
    expect(result?.artifactVersionId).toBe(11)
  })

  it('keeps the prior LLM values when no LLM call is made (budget spent or no model)', async () => {
    const result = await reprocessAuction(
      'zvg-portal', '7265', priorLlmEntry, null, '2026-08-02T11:00:00.000Z',
      { artifactState: changedSetState },
    )

    expect(result?.entry).toMatchObject({
      condition: 'gepflegt', yearBuilt: 1936, marketValueEur: 250_000, llmAnalyzedAt: '2026-08-01T10:00:00.000Z',
    })
    expect(result?.artifactVersionId).toBe(11)
  })
})

describe('runReprocess empty LLM input', () => {
  it('books no LLM call and keeps the failure count, but records the attempt time', async () => {
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{
      baseUrl: 'https://api.example.test', apiKey: 'secret', model: 'test-model', provider: 'openai-compatible',
    }])
    vi.mocked(extractByLlm).mockResolvedValue(null)

    await expect(runReprocess({ country: 'de' })).resolves.toMatchObject({ processed: 1, llmCalls: 0 })

    expect(writeAuctionLlmPipelineState).toHaveBeenCalledWith('zvg-portal', '7265', {
      llmBatchJob: null,
      llmArtifactVersionId: null,
      llmRulesHint: null,
      llmFailures: 0,
      llmAttempted: true,
    })
  })
})

describe('reprocessAuction map-reduce', () => {
  const config = { baseUrl: 'https://api.example.test', apiKey: 'k', model: 'test-model', provider: 'openai-compatible' as const }

  function clampedExtraction(overrides: Partial<import('../utils/extract/llm-clamp').ClampedExtraction> = {}) {
    return {
      propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null,
      bedrooms: null, bathrooms: null, floor: null, bathroomHasTub: null, bathroomHasShower: null,
      heating: null, units: null, securityDeposit: null, ruleCheck: null,
      biddingNotes: null, condition: null, features: [], yearBuilt: null, lastRenovationYear: null,
      renovationNotes: null, insights: null, planningNotes: null, documentSummary: null,
      marketValueEur: null, marketValueText: null, photoCuration: [],
      ...overrides,
    }
  }

  function mapReduceBase(overrides: Partial<ReprocessInput> = {}): ReprocessInput {
    return {
      fields: { propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null, units: null, securityDeposit: null },
      input: { title: 'Testauktion', description: 'Beschreibung' },
      documentSummaryInputs: [
        { label: 'Gutachten', parts: { pdfText: 'Gutachten Text', pdfPageImages: null, pdfBytes: null } },
        { label: 'Exposé', parts: { pdfText: 'Exposé Text', pdfPageImages: null, pdfBytes: null } },
      ],
      documentSetChanged: false,
      documentSetComplete: true,
      artifactVersionId: 5,
      photoSourceIndices: undefined,
      auction: auction(),
      ...overrides,
    }
  }

  it('runs every document group plus one reduce call, counted as N+1 real attempts', async () => {
    vi.mocked(extractByLlm).mockImplementation(async (input, _cfg, opts) => {
      opts?.onProviderAttempt?.()
      return opts?.name === DOCUMENT_SUMMARY_SCHEMA_NAME
        ? clampedExtraction({ documentSummary: `map:${(input as { pdfText?: string }).pdfText}` })
        : clampedExtraction({ propertyType: 'eigentumswohnung' })
    })
    const onLlmAttempt = vi.fn()

    const result = await reprocessAuction(
      'zvg-portal', '7265', undefined, config, '2026-08-02T11:00:00.000Z',
      { artifactState: emptyArtifactState, prebuiltBase: mapReduceBase(), onLlmAttempt },
    )

    expect(result?.llmCalled).toBe(true)
    expect(result?.llmFailures).toBe(0)
    expect(result?.entry.propertyType).toBe('eigentumswohnung')
    expect(extractByLlm).toHaveBeenCalledTimes(3)
    expect(onLlmAttempt).toHaveBeenCalledTimes(3)
  })

  it('skips without spending anything when the remaining budget cannot fit a map+reduce sequence', async () => {
    const result = await reprocessAuction(
      'zvg-portal', '7265', undefined, config, '2026-08-02T11:00:00.000Z',
      { artifactState: emptyArtifactState, prebuiltBase: mapReduceBase(), remainingLlmBudget: 1 },
    )

    expect(result).toBeNull()
    expect(extractByLlm).not.toHaveBeenCalled()
  })

  it('slices document groups to fit the remaining budget instead of overspending it', async () => {
    vi.mocked(extractByLlm).mockImplementation(async (_input, _cfg, opts) => {
      opts?.onProviderAttempt?.()
      return clampedExtraction()
    })

    // 2 document groups available, but only 2 calls of budget — must take
    // exactly 1 group (+ 1 reduce), never both groups (+ 1 reduce = 3).
    await reprocessAuction(
      'zvg-portal', '7265', undefined, config, '2026-08-02T11:00:00.000Z',
      { artifactState: emptyArtifactState, prebuiltBase: mapReduceBase(), remainingLlmBudget: 2 },
    )

    expect(extractByLlm).toHaveBeenCalledTimes(2)
  })

  const parsedElsewhereState = {
    latest: { id: 5, platform: 'zvg-portal', externalId: '7265', version: 2, setHash: 'new-set' },
    parsedArtifactVersionId: 4,
  }

  it('marks the document set as parsed only when every group was read', async () => {
    vi.mocked(extractByLlm).mockImplementation(async (_input, _cfg, opts) => {
      opts?.onProviderAttempt?.()
      return clampedExtraction()
    })

    const result = await reprocessAuction(
      'zvg-portal', '7265', undefined, config, '2026-08-02T11:00:00.000Z',
      { artifactState: parsedElsewhereState, prebuiltBase: mapReduceBase() },
    )

    expect(result?.artifactVersionId).toBe(5)
  })

  it('leaves the document set unparsed when groups were cut for the budget', async () => {
    vi.mocked(extractByLlm).mockImplementation(async (_input, _cfg, opts) => {
      opts?.onProviderAttempt?.()
      return clampedExtraction({ documentSummary: 'teilweise' })
    })

    const result = await reprocessAuction(
      'zvg-portal', '7265', undefined, config, '2026-08-02T11:00:00.000Z',
      { artifactState: parsedElsewhereState, prebuiltBase: mapReduceBase(), remainingLlmBudget: 2, priorLlmFailures: 1 },
    )

    expect(result?.entry.documentSummary).toBe('teilweise')
    expect(result?.artifactVersionId).toBe(4)
    // A budget cut is not a failure.
    expect(result?.llmFailures).toBe(0)
  })

  it('leaves the document set unparsed and counts a failure when a map call failed', async () => {
    vi.mocked(extractByLlm).mockImplementation(async (input, _cfg, opts) => {
      opts?.onProviderAttempt?.()
      if (opts?.name === DOCUMENT_SUMMARY_SCHEMA_NAME && (input as { pdfText?: string }).pdfText === 'Gutachten Text') return null
      return clampedExtraction({ documentSummary: 'ohne Gutachten' })
    })

    const result = await reprocessAuction(
      'zvg-portal', '7265', undefined, config, '2026-08-02T11:00:00.000Z',
      { artifactState: parsedElsewhereState, prebuiltBase: mapReduceBase(), priorLlmFailures: 1 },
    )

    expect(result?.entry.documentSummary).toBe('ohne Gutachten')
    expect(result?.artifactVersionId).toBe(4)
    expect(result?.llmFailures).toBe(2)
  })

  it('increments llmFailures and reports failure when every map call fails', async () => {
    vi.mocked(extractByLlm).mockImplementation(async (_input, _cfg, opts) => {
      opts?.onProviderAttempt?.()
      return null
    })

    const result = await reprocessAuction(
      'zvg-portal', '7265', undefined, config, '2026-08-02T11:00:00.000Z',
      { artifactState: emptyArtifactState, prebuiltBase: mapReduceBase(), priorLlmFailures: 1 },
    )

    expect(result?.llmCalled).toBe(true)
    expect(result?.llmFailures).toBe(2)
    // Both maps attempted, no reduce call once neither produced anything.
    expect(extractByLlm).toHaveBeenCalledTimes(2)
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
        llmCostUsd: null,
        llmInputTokens: null,
        llmOutputTokens: null,
      },
    )
    expect(writeAuctionLlmPipelineState).toHaveBeenCalledWith('zvg-portal', '7265', {
      llmBatchJob: null,
      llmArtifactVersionId: null,
      llmRulesHint: null,
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
      sourceUpdatedIso: null, detailFetchedAt: null, enrichClaimedAt: null, llmBatchJob: null,
      llmArtifactVersionId: null, llmRulesHint: null, llmFailures: 2, llmLastAttemptedAt: null, llmClaimedAt: null, photosCheckedAt: null,
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
        llmCostUsd: null,
        llmInputTokens: null,
        llmOutputTokens: null,
      },
    )
    // The rules values shown to the model are snapshotted with the submitted
    // item, so llm-batch-poll can tell a stale verdict from a current one.
    expect(writeAuctionLlmPipelineState).toHaveBeenLastCalledWith('zvg-portal', '7265', {
      llmBatchJob: 'batch-22',
      llmArtifactVersionId: 22,
      llmRulesHint: { propertyType: 'einfamilienhaus', rooms: null, units: null, securityDeposit: null },
      llmFailures: 2,
      llmAttempted: true,
    })
  })

  it('keeps a prior LLM extraction visible and warns when a forced batch submission fails', async () => {
    const prior = extraction({ llmAnalyzedAt: '2026-08-01T10:00:00.000Z' })
    vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map([['zvg-portal:7265', {
      auction: { ...auction(), extraction: prior },
      detailsId: 7,
      detailsVersion: 2,
      artifactVersionId: 11,
    }]]))
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{
      baseUrl: 'https://api.example.test', apiKey: 'secret', model: 'batch-model', provider: 'openai-compatible',
    }])
    vi.mocked(submitLlmBatch).mockResolvedValue(null)

    const result = await runReprocess({ country: 'de', batch: true, force: true })

    expect(result.warning).toContain('LLM-Batch-Einreichung')
    expect(writeAuctionDetails).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ source: 'llm', livingAreaSqm: 120, landAreaSqm: 500, llmAnalyzedAt: prior.llmAnalyzedAt }),
      expect.any(Object),
    )
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
    vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
      opts?.onProviderAttempt?.()
      return null
    })

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

  it('claims the item before the sync LLM call and clears the claim once it resolves', async () => {
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{
      baseUrl: 'https://api.example.test', apiKey: 'secret', model: 'vision-model', provider: 'gemini-native',
    }])
    vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
      opts?.onProviderAttempt?.()
      return null
    })

    await expect(runReprocess({ country: 'de' })).resolves.toMatchObject({ processed: 1 })

    expect(writeAuctionLlmClaim).toHaveBeenCalledWith('zvg-portal', '7265', expect.any(String))
    expect(vi.mocked(writeAuctionLlmClaim).mock.calls).toHaveLength(1)
    // writeAuctionLlmPipelineState is the real writer's unconditional
    // llm_claimed_at = NULL — asserting this call actually happened is what
    // proves the claim was cleared, not just that it was set beforehand.
    expect(writeAuctionLlmPipelineState).toHaveBeenCalledWith('zvg-portal', '7265', {
      llmBatchJob: null,
      llmArtifactVersionId: null,
      llmRulesHint: null,
      llmFailures: 1,
      llmAttempted: true,
    })
  })

  it('does not claim a candidate that never reaches a real LLM call (rules-only, no config)', async () => {
    await expect(runReprocess({ country: 'de' })).resolves.toMatchObject({ processed: 1 })
    expect(writeAuctionLlmClaim).not.toHaveBeenCalled()
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

  it('writes the provider-reported cost on the version when the synchronous call reports one', async () => {
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{
      baseUrl: 'https://api.example.test', apiKey: 'secret', model: 'vision-model', provider: 'gemini-native', profileId: 'profile-a',
    }])
    vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
      opts?.onProviderAttempt?.()
      opts?.onUsage?.({ inputTokens: 800, outputTokens: 120, costUsd: 0.0042 })
      return null
    })

    await expect(runReprocess({ country: 'de', trigger: 'manual' })).resolves.toMatchObject({ processed: 1 })

    expect(writeAuctionDetails).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ llmCostUsd: 0.0042 }),
    )
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

describe('runReprocessTask', () => {
  it('skips a scheduled run while a manual run is active instead of superseding it', async () => {
    const records = await readAuctionRecordMap()
    let releaseManual!: () => void
    const manualBlocks = new Promise<void>((resolve) => { releaseManual = resolve })
    vi.mocked(readAuctionRecordMap).mockImplementationOnce(async () => {
      await manualBlocks
      return records
    })

    const manual = runReprocessTask({ trigger: 'manual' })
    await vi.waitFor(() => expect(readAuctionRecordMap).toHaveBeenCalledTimes(2))
    // The cron payload carries no trigger.
    const scheduled = runReprocessTask({})

    releaseManual()
    await expect(scheduled).resolves.toStrictEqual({})
    await expect(manual).resolves.toMatchObject({ result: expect.objectContaining({ processed: 1 }) })
    expect(recordTaskRunStart).toHaveBeenCalledTimes(1)
  })
})

describe('runReprocess llm_failures cooldown', () => {
  function lockedOutFetchState(llmLastAttemptedAt: string | null) {
    return new Map([['zvg-portal:7265', {
      platform: 'zvg-portal', externalId: '7265', pdfUrl: null, pdfUrlUpstream: null,
      detailUrl: null, detailUrlUpstream: null, attachments: [], photoUrls: null,
      sourceUpdatedIso: null, detailFetchedAt: null, enrichClaimedAt: null, llmBatchJob: null,
      llmArtifactVersionId: null, llmRulesHint: null, llmFailures: 3, llmLastAttemptedAt, llmClaimedAt: null, photosCheckedAt: null,
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
    expect(writeAuctionLlmClaim).not.toHaveBeenCalled()
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

  it('openOnly keeps a cooled-down locked-out candidate excluded — "Retry open" must never silently retry a past failure', async () => {
    vi.mocked(readAuctionFetchStates).mockResolvedValue(
      lockedOutFetchState(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()), // 25h ago — past cooldown
    )

    await expect(runReprocess({ country: 'de', openOnly: true })).resolves.toMatchObject({ processed: 0, skipped: 1 })
  })

  it('openOnly still processes a genuinely open (never-attempted) candidate', async () => {
    // Default beforeEach state: no fetch state at all — llm_failures=0, the
    // country's ordinary open/never-attempted bucket. openOnly must not be
    // stricter than plain eligibility for the case it's actually meant for.
    await expect(runReprocess({ country: 'de', openOnly: true })).resolves.toMatchObject({ processed: 1, skipped: 0 })
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
      llmRulesHint: null,
      llmFailures: 3,
      llmAttempted: true,
    })
    // A throw past onLlmAttempt still has to clear the claim explicitly — it
    // never reaches persistEntry's writeAuctionLlmPipelineState call.
    expect(writeAuctionLlmClaim).toHaveBeenLastCalledWith('zvg-portal', '7265', null)
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

  it('manual failed-only retries bypass the per-run budget for every failed candidate', async () => {
    const firstState = lockedOutFetchState(new Date(Date.now() - 60 * 60 * 1000).toISOString()).get('zvg-portal:7265')!
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn(async () => ({ rows: [
        { platform: 'zvg-portal', external_id: '7265', country: 'de' },
        { platform: 'zvg-portal', external_id: '7266', country: 'de' },
      ] })),
    } as never)
    vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map([
      ['zvg-portal:7265', { auction: auction(), detailsId: 7, detailsVersion: 2, artifactVersionId: null }],
      ['zvg-portal:7266', { auction: { ...auction(), externalId: '7266' }, detailsId: 8, detailsVersion: 2, artifactVersionId: null }],
    ]))
    vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map([
      ['zvg-portal:7265', firstState],
      ['zvg-portal:7266', { ...firstState, externalId: '7266' }],
    ]))
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{
      baseUrl: 'https://api.example.test', apiKey: 'secret', model: 'test-model', provider: 'openai-compatible',
    }])
    vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
      opts?.onProviderAttempt?.()
      return null
    })

    await expect(runReprocess({
      country: 'de', failedOnly: true, ignoreCooldown: true, ignoreLlmBudget: true,
    })).resolves.toMatchObject({ processed: 2, llmCalls: 2 })
    expect(extractByLlm).toHaveBeenCalledTimes(2)
  })

  it('manual failed-only retries give map-reduce candidates an unlimited remaining budget', async () => {
    const firstState = lockedOutFetchState(new Date(Date.now() - 60 * 60 * 1000).toISOString()).get('zvg-portal:7265')!
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn(async () => ({ rows: [
        { platform: 'zvg-portal', external_id: '7265', country: 'de' },
        { platform: 'zvg-portal', external_id: '7266', country: 'de' },
      ] })),
    } as never)
    vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map([
      ['zvg-portal:7265', { auction: auction(), detailsId: 7, detailsVersion: 2, artifactVersionId: null }],
      ['zvg-portal:7266', { auction: { ...auction(), externalId: '7266' }, detailsId: 8, detailsVersion: 2, artifactVersionId: null }],
    ]))
    vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map([
      ['zvg-portal:7265', firstState],
      ['zvg-portal:7266', { ...firstState, externalId: '7266' }],
    ]))
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{
      baseUrl: 'https://api.example.test', apiKey: 'secret', model: 'test-model', provider: 'openai-compatible',
    }])
    vi.mocked(prepareArchivedLlmDocuments).mockResolvedValue({
      input: {
        documentSummaryInputs: [{
          label: 'Gutachten',
          parts: { pdfText: 'Gutachten Text', pdfPageImages: null, pdfBytes: null },
        }],
      },
      documentSetItems: [],
      documentSetComplete: true,
      artifactVersionId: null,
    } as never)
    const llmResult: ClampedExtraction = {
      propertyType: null, landAreaSqm: null, livingAreaSqm: null, rooms: null,
      bedrooms: null, bathrooms: null, floor: null, bathroomHasTub: null, bathroomHasShower: null,
      heating: null, units: null, securityDeposit: null, ruleCheck: null,
      biddingNotes: null, condition: null, features: [], yearBuilt: null, lastRenovationYear: null,
      renovationNotes: null, insights: null, planningNotes: null, documentSummary: 'summary',
      marketValueEur: null, marketValueText: null, photoCuration: [],
    }
    vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
      opts?.onProviderAttempt?.()
      return llmResult
    })

    await expect(runReprocess({
      country: 'de', failedOnly: true, ignoreCooldown: true, ignoreLlmBudget: true,
    })).resolves.toMatchObject({ processed: 2, llmCalls: 4 })
    expect(extractByLlm).toHaveBeenCalledTimes(4)
  })
})

describe('runReprocess isLlmBatchPending gate', () => {
  function batchPendingFetchState() {
    return new Map([['zvg-portal:7265', {
      platform: 'zvg-portal', externalId: '7265', pdfUrl: null, pdfUrlUpstream: null,
      detailUrl: null, detailUrlUpstream: null, attachments: [], photoUrls: null,
      sourceUpdatedIso: null, detailFetchedAt: null, enrichClaimedAt: null,
      llmBatchJob: 'openrouter_batch-stuck', llmArtifactVersionId: null, llmRulesHint: null, llmFailures: 0,
      llmLastAttemptedAt: null, llmClaimedAt: null, photosCheckedAt: null,
      photoFailures: 0, photoLastAttemptedAt: null, photoPipelineVersion: null,
      updatedAt: '2026-08-02T10:00:00.000Z',
    }]])
  }

  it('skips a candidate still carrying an unresolved batch-job marker', async () => {
    vi.mocked(readAuctionFetchStates).mockResolvedValue(batchPendingFetchState())
    vi.mocked(isLlmBatchPending).mockReturnValueOnce(true)

    await expect(runReprocess({ country: 'de' })).resolves.toMatchObject({ processed: 0, skipped: 1 })
  })

  it('ignoreBatchPending bypasses a stuck/failed batch marker so the open backlog can retry immediately', async () => {
    vi.mocked(readAuctionFetchStates).mockResolvedValue(batchPendingFetchState())

    await expect(runReprocess({ country: 'de', ignoreBatchPending: true }))
      .resolves.toMatchObject({ processed: 1, skipped: 0 })
    // Short-circuited by opts.ignoreBatchPending — never even asks whether
    // the marker is actually still pending.
    expect(isLlmBatchPending).not.toHaveBeenCalled()
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
        llmCostUsd: null,
        llmInputTokens: null,
        llmOutputTokens: null,
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

describe('runReprocess parallel lanes', () => {
  const ids = Array.from({ length: 12 }, (_, i) => String(100 + i))

  function seedCandidates(): void {
    // Earlier tests leave unconsumed *Once values behind (clearAllMocks keeps
    // them), so start these from a clean slate.
    for (const fn of [listDistinctCaptures, downloadBlob, readArtifactProcessingState, readAuctionFetchStates, writeAuctionDetails, extractByLlm, isRateLimitError]) {
      vi.mocked(fn).mockReset()
    }
    vi.mocked(isRateLimitError).mockReturnValue(false)
    vi.mocked(prepareArchivedLlmDocuments).mockReset()
    vi.mocked(prepareArchivedLlmDocuments).mockImplementation(async (_auction, opts) => ({
      input: {},
      documentSetItems: [],
      documentSetComplete: true,
      artifactVersionId: opts.artifactVersionId,
    }) as never)
    vi.mocked(isLlmBatchPending).mockReset()
    vi.mocked(isLlmBatchPending).mockReturnValue(false)
    vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map())
    vi.mocked(readArtifactProcessingState).mockResolvedValue(emptyArtifactState)
    vi.mocked(writeAuctionDetails).mockResolvedValue({ version: 3, changed: true })
    vi.mocked(listDistinctCaptures).mockResolvedValue([{ contentHash: 'auction-hash', sourceUrl: null, capturedAt: '2026-08-02T10:00:00.000Z' }])
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn(async () => ({ rows: ids.map((id) => ({ platform: 'zvg-portal', external_id: id, country: 'de' })) })),
    } as never)
    vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map(ids.map((id) => [`zvg-portal:${id}`, {
      auction: { ...auction(), externalId: id },
      detailsId: 7,
      detailsVersion: 2,
      artifactVersionId: null,
    }])))
    vi.mocked(downloadBlob).mockImplementation(async () => Buffer.from(JSON.stringify(auction())))
    vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([{
      baseUrl: 'https://api.example.test', apiKey: 'secret', model: 'vision-model', provider: 'gemini-native',
    }])
  }

  function trackInFlight() {
    const stats = { active: 0, peak: 0, calls: 0 }
    vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
      opts?.onProviderAttempt?.()
      stats.calls++
      stats.active++
      stats.peak = Math.max(stats.peak, stats.active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      stats.active--
      return null
    })
    return stats
  }

  it('runs candidates in parallel up to the configured lane count and never beyond the budget', async () => {
    seedCandidates()
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { maxPerRun: '5' } }))
    vi.mocked(getLlmConcurrency).mockResolvedValue(3)
    const stats = trackInFlight()

    const result = await runReprocess({ country: 'de' })

    expect(stats.peak).toBe(3)
    // The shared budget holds exactly even with lanes racing for the last slots.
    expect(stats.calls).toBe(5)
    expect(result).toMatchObject({ candidates: 12, processed: 12, llmCalls: 5 })
  })

  it('reserves the full map-reduce call budget across parallel lanes', async () => {
    seedCandidates()
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { maxPerRun: '5' } }))
    vi.mocked(getLlmConcurrency).mockResolvedValue(3)
    vi.mocked(prepareArchivedLlmDocuments).mockImplementation(async (_auction, opts) => ({
      input: {
        documentSummaryInputs: [
          { label: 'Gutachten', parts: { pdfText: 'Gutachten', pdfPageImages: null, pdfBytes: null } },
          { label: 'Exposé', parts: { pdfText: 'Exposé', pdfPageImages: null, pdfBytes: null } },
          { label: 'Grundriss', parts: { pdfText: 'Grundriss', pdfPageImages: null, pdfBytes: null } },
        ],
      },
      documentSetItems: [],
      documentSetComplete: true,
      artifactVersionId: opts.artifactVersionId,
    }) as never)
    const stats = { calls: 0 }
    const extraction = { documentSummary: 'summary', photoCuration: [], ruleCheck: null } as unknown as ClampedExtraction
    vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
      opts?.onProviderAttempt?.()
      stats.calls++
      return extraction
    })

    const result = await runReprocess({ country: 'de' })

    expect(stats.calls).toBeLessThanOrEqual(5)
    expect(result.llmCalls).toBe(stats.calls)
  })

  it('keeps per-country progress consistent with the totals', async () => {
    seedCandidates()
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { maxPerRun: '4' } }))
    vi.mocked(getLlmConcurrency).mockResolvedValue(4)
    trackInFlight()

    await runReprocess({ country: 'de' })

    const [, , extra] = vi.mocked(recordTaskRunProgress).mock.calls.at(-1)!
    expect(extra?.progressByCountry?.de).toEqual({ candidatesTotal: 12, processed: 12, skipped: 0, llmCalls: 4, llmErrors: 0 })
  })

  it('stops handing out candidates after a rate limit, letting in-flight ones finish', async () => {
    seedCandidates()
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { maxPerRun: '50' } }))
    vi.mocked(getLlmConcurrency).mockResolvedValue(2)
    const rateLimit = new Error('429 too many requests')
    vi.mocked(isRateLimitError).mockImplementation((err) => err === rateLimit)
    let calls = 0
    vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
      opts?.onProviderAttempt?.()
      calls++
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw rateLimit
    })

    const result = await runReprocess({ country: 'de' })

    expect(calls).toBeLessThanOrEqual(2)
    expect(result.warning).toBeDefined()
    expect(result.processed).toBe(0)
  })

  it('hands budget the smaller platforms left unused to a platform that hit its fair share', async () => {
    // Fair share = ceil(6 / 2 platforms) = 3. kip has only 2 candidates, so one
    // slot would go unused — the big platform must get it in a second pass.
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => ({ platform: 'zvg-portal', external_id: String(200 + i), country: 'de' })),
      ...Array.from({ length: 2 }, (_, i) => ({ platform: 'kip', external_id: `K${i}`, country: 'de' })),
    ]
    seedCandidates()
    vi.mocked(getPool).mockReturnValue({ query: vi.fn(async () => ({ rows })) } as never)
    vi.mocked(readAuctionRecordMap).mockResolvedValue(new Map(rows.map((r) => [`${r.platform}:${r.external_id}`, {
      auction: { ...auction(), platform: r.platform, externalId: r.external_id },
      detailsId: 7,
      detailsVersion: 2,
      artifactVersionId: null,
    }])))
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { maxPerRun: '6' } }))
    vi.mocked(getLlmConcurrency).mockResolvedValue(1)
    const stats = trackInFlight()

    const result = await runReprocess({ country: 'de' })

    const expectedIds = rows.map((row) => `${row.platform}:${row.external_id}`)
    const processedIds = vi.mocked(writeAuctionDetails).mock.calls.map(([updated]) =>
      `${updated.platform}:${updated.externalId}`,
    )
    expect(processedIds).toHaveLength(expectedIds.length)
    expect(new Set(processedIds)).toEqual(new Set(expectedIds))

    const usageByPlatform = (platform: string) =>
      vi.mocked(recordLlmUsage).mock.calls.filter(([entry]) => entry.platform === platform).length
    expect(stats.calls).toBe(6) // the whole budget is used, not 5
    expect(usageByPlatform('kip')).toBe(2)
    expect(usageByPlatform('zvg-portal')).toBe(4)
    // every candidate is handled exactly once, deferred or not
    expect(result).toMatchObject({ candidates: 12, processed: 12, skipped: 0, llmCalls: 6 })
  })

  describe('a lost provider connection (proxy restart)', () => {
    /** Makes the first provider request fail as a proxy restart would. */
    function loseConnectionOnce(): void {
      const lost = new Error('claude-proxy: <no response> fetch failed')
      vi.mocked(isLlmProviderError).mockImplementation((err) => err === lost)
      vi.mocked(isConnectionLostError).mockImplementation((err) => err === lost)
      let first = true
      vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
        opts?.onProviderAttempt?.()
        if (first) { first = false; throw lost }
        return null
      })
    }

    afterEach(() => {
      vi.mocked(isLlmProviderError).mockReset().mockReturnValue(false)
      vi.mocked(isLlmProviderUnavailable).mockReset().mockReturnValue(false)
      vi.mocked(isConnectionLostError).mockReset().mockReturnValue(false)
      vi.mocked(waitForProviderRecovery).mockReset().mockResolvedValue(false)
    })

    it('keeps the run going once the provider answers again, leaving only the interrupted candidate open', async () => {
      seedCandidates()
      vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { maxPerRun: '50' } }))
      vi.mocked(getLlmConcurrency).mockResolvedValue(1)
      vi.mocked(waitForProviderRecovery).mockResolvedValue(true)
      loseConnectionOnce()

      const result = await runReprocess({ country: 'de' })

      expect(waitForProviderRecovery).toHaveBeenCalledTimes(1)
      expect(result.warning).toBeUndefined()
      expect(result).toMatchObject({ candidates: 12, skipped: 1, processed: 11 })
    })

    it('still stops the run when the provider does not come back', async () => {
      seedCandidates()
      vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { maxPerRun: '50' } }))
      vi.mocked(getLlmConcurrency).mockResolvedValue(1)
      vi.mocked(waitForProviderRecovery).mockResolvedValue(false)
      loseConnectionOnce()

      const result = await runReprocess({ country: 'de' })

      expect(result.warning).toContain('LLM-Providerfehler')
      expect(result.processed).toBe(0)
    })

    it('probes the fallback provider that actually failed', async () => {
      seedCandidates()
      const primary = { baseUrl: 'https://primary.example.test', apiKey: 'primary', model: 'primary', provider: 'gemini-native' as const }
      const fallback = { baseUrl: 'http://proxy:8080/', apiKey: '', model: 'fallback', provider: 'claude-proxy' as const }
      vi.mocked(readExtractionLlmConfigChain).mockResolvedValue([primary, fallback])
      vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { maxPerRun: '50' } }))
      vi.mocked(getLlmConcurrency).mockResolvedValue(1)
      const primaryUnavailable = new Error('primary unavailable')
      const fallbackLost = new Error('claude-proxy: <no response> fetch failed')
      vi.mocked(isLlmProviderError).mockImplementation((err) => err === primaryUnavailable || err === fallbackLost)
      vi.mocked(isLlmProviderUnavailable).mockImplementation((err) => err === primaryUnavailable || err === fallbackLost)
      vi.mocked(isConnectionLostError).mockImplementation((err) => err === fallbackLost)
      vi.mocked(waitForProviderRecovery).mockResolvedValue(true)
      let calls = 0
      vi.mocked(extractByLlm).mockImplementation(async (_input, _config, opts) => {
        opts?.onProviderAttempt?.()
        calls++
        if (calls === 1) throw primaryUnavailable
        if (calls === 2) throw fallbackLost
        return null
      })

      const result = await runReprocess({ country: 'de' })

      expect(waitForProviderRecovery).toHaveBeenCalledWith(fallback)
      expect(result.warning).toBeUndefined()
      expect(result).toMatchObject({ candidates: 12, skipped: 1, processed: 11 })
    })
  })
})
