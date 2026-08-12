import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/llm-batch-jobs', () => ({
  listPendingLlmBatchJobs: vi.fn(),
  listRecentLlmBatchJobs: vi.fn(),
  getAllLlmBatchCapabilities: vi.fn(),
}))
vi.mock('~/server/utils/auction-record', () => ({ readAuctionRecords: vi.fn() }))
vi.mock('~/server/utils/auction-fetch-state', () => ({ readAuctionFetchStates: vi.fn(async () => new Map()) }))
vi.mock('~/server/utils/extract/gemini-batch', () => ({ isGeminiBatchTierPaid: vi.fn() }))
vi.mock('~/server/utils/task-runs', () => ({ getTaskRunStatus: vi.fn() }))

const IDLE_REPROCESS_STATUS = {
  status: 'idle' as const,
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  lastError: null,
  lastWarning: null,
  lastLlmError: null,
  progress: null,
  progressByCountry: null,
}

function record(key: string, extraction: Record<string, unknown> | undefined, country = 'de') {
  const separator = key.indexOf(':')
  return {
    detailsId: 1,
    detailsVersion: 1,
    auction: {
      platform: key.slice(0, separator),
      externalId: key.slice(separator + 1),
      country,
      extraction,
    },
  } as never
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/llm-batch-jobs', () => {
  it('summarizes pending jobs and their waiting request keys', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { listPendingLlmBatchJobs, listRecentLlmBatchJobs, getAllLlmBatchCapabilities } =
      await import('~/server/utils/llm-batch-jobs')
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { readAuctionFetchStates } = await import('~/server/utils/auction-fetch-state')
    const { isGeminiBatchTierPaid } = await import('~/server/utils/extract/gemini-batch')
    const { getTaskRunStatus } = await import('~/server/utils/task-runs')
    vi.mocked(isGeminiBatchTierPaid).mockReturnValue(true)
    vi.mocked(getTaskRunStatus).mockResolvedValue(IDLE_REPROCESS_STATUS)
    const pendingJobs = [
      {
        jobName: 'msgbatch_abc',
        source: 'reprocess',
        status: 'pending',
        itemCount: 2,
        customIdMap: { request_0: 'zvg-portal:1' },
        submittedAt: '2026-07-26T18:00:00.000Z',
        checkedAt: null,
        updatedAt: '2026-07-26T18:00:00.000Z',
        errorMessage: null,
        provider: null,
        model: null,
        profileId: null,
      },
    ] as const
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([...pendingJobs])
    vi.mocked(listRecentLlmBatchJobs).mockResolvedValue([
      ...pendingJobs,
      {
        jobName: 'batch_done',
        source: 'enrich',
        status: 'succeeded',
        itemCount: 1,
        customIdMap: { zvg_0: 'zvg-portal:done' },
        submittedAt: '2026-07-25T18:00:00.000Z',
        checkedAt: '2026-07-25T19:00:00.000Z',
        updatedAt: '2026-07-25T19:00:00.000Z',
        errorMessage: null,
        provider: null,
        model: null,
        profileId: null,
      },
    ])
    vi.mocked(getAllLlmBatchCapabilities).mockResolvedValue({
      'gemini-native': { ok: false, message: 'FAILED_PRECONDITION: Precondition check failed.', checkedAt: '2026-07-26T18:00:00.000Z', source: 'enrich' },
    })
    vi.mocked(readAuctionRecords).mockResolvedValue([
      record('zvg-portal:1', { llmBatchJob: 'msgbatch_abc', at: '2026-07-26T18:00:00.000Z' }),
      record('zvg-portal:2', { llmBatchJob: 'msgbatch_abc', at: '2026-07-26T18:00:00.000Z' }),
      record('zvg-portal:3', { at: '2026-07-26T18:00:00.000Z' }),
      record('zvg-portal:4', { source: 'rules', confidence: 'low', at: '2026-07-26T18:00:00.000Z' }),
      record('zvg-portal:5', { llmBatchJob: 'deleted_job', at: '2026-07-26T18:00:00.000Z' }),
      // Never run through even the rules-only fallback (brand-new crawl) —
      // must still count toward readyRequests, not be silently dropped.
      record('zvg-portal:6', undefined, 'se'),
    ])
    vi.mocked(readAuctionFetchStates).mockResolvedValue(new Map([
      ['zvg-portal:1', { llmBatchJob: 'msgbatch_abc', llmFailures: 0 } as never],
      ['zvg-portal:2', { llmBatchJob: 'msgbatch_abc', llmFailures: 0 } as never],
      ['zvg-portal:5', { llmBatchJob: 'deleted_job', llmFailures: 0 } as never],
    ]))

    const handler = (await import('./llm-batch-jobs.get')).default as () => Promise<unknown>

    await expect(handler()).resolves.toEqual({
      totalJobs: 1,
      totalRequests: 2,
      backlog: {
        readyRequests: 3,
        neverExtracted: 1,
        lowConfidenceRules: 1,
        missingLlmFields: 2,
        orphanedBatchMarkers: 1,
        failedLimit: 0,
        sampleRequestKeys: ['zvg-portal:3', 'zvg-portal:4', 'zvg-portal:6'],
        orphanedRequestKeys: ['zvg-portal:5'],
      },
      backlogByCountry: {
        de: { readyRequests: 2, failedLimit: 0 },
        se: { readyRequests: 1, failedLimit: 0 },
      },
      jobs: [
        {
          jobName: 'msgbatch_abc',
          source: 'reprocess',
          status: 'pending',
          provider: 'anthropic',
          itemCount: 2,
          pendingCount: 2,
          requestKeys: ['zvg-portal:1', 'zvg-portal:2'],
          submittedAt: '2026-07-26T18:00:00.000Z',
          checkedAt: null,
          updatedAt: '2026-07-26T18:00:00.000Z',
          errorMessage: null,
        },
      ],
      recentJobs: [
        {
          jobName: 'msgbatch_abc',
          source: 'reprocess',
          status: 'pending',
          provider: 'anthropic',
          itemCount: 2,
          pendingCount: 2,
          requestKeys: ['zvg-portal:1', 'zvg-portal:2'],
          submittedAt: '2026-07-26T18:00:00.000Z',
          checkedAt: null,
          updatedAt: '2026-07-26T18:00:00.000Z',
          errorMessage: null,
        },
        {
          jobName: 'batch_done',
          source: 'enrich',
          status: 'succeeded',
          provider: 'openai',
          itemCount: 1,
          pendingCount: 0,
          requestKeys: ['zvg-portal:done'],
          submittedAt: '2026-07-25T18:00:00.000Z',
          checkedAt: '2026-07-25T19:00:00.000Z',
          updatedAt: '2026-07-25T19:00:00.000Z',
          errorMessage: null,
        },
      ],
      capabilities: {
        'gemini-native': { ok: false, message: 'FAILED_PRECONDITION: Precondition check failed.', checkedAt: '2026-07-26T18:00:00.000Z', source: 'enrich' },
      },
      reprocessStatus: IDLE_REPROCESS_STATUS,
      enrichStatus: IDLE_REPROCESS_STATUS,
      externalEnrichmentStatus: IDLE_REPROCESS_STATUS,
      offloadImagesStatus: IDLE_REPROCESS_STATUS,
      copernicusEffisImportStatus: IDLE_REPROCESS_STATUS,
      euFloodRiskImportStatus: IDLE_REPROCESS_STATUS,
    })
    expect(getTaskRunStatus).toHaveBeenCalledWith('reprocess')
    expect(getTaskRunStatus).toHaveBeenCalledWith('enrich')
    expect(getTaskRunStatus).toHaveBeenCalledWith('external-enrichment')
    expect(getTaskRunStatus).toHaveBeenCalledWith('offload-images')
    expect(getTaskRunStatus).toHaveBeenCalledWith('import-copernicus-effis-cache')
    expect(getTaskRunStatus).toHaveBeenCalledWith('import-eu-flood-risk-cache')
  })

  it('maps an "openrouter_"-wrapped jobName to the openrouter provider, not openai', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { listPendingLlmBatchJobs, listRecentLlmBatchJobs, getAllLlmBatchCapabilities } =
      await import('~/server/utils/llm-batch-jobs')
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { isGeminiBatchTierPaid } = await import('~/server/utils/extract/gemini-batch')
    const { getTaskRunStatus } = await import('~/server/utils/task-runs')
    const job = {
      jobName: 'openrouter_batch_x',
      source: 'reprocess',
      status: 'pending',
      itemCount: 1,
      customIdMap: {},
      submittedAt: '2026-08-08T18:00:00.000Z',
      checkedAt: null,
      updatedAt: '2026-08-08T18:00:00.000Z',
      errorMessage: null,
      provider: null,
      model: null,
      profileId: null,
    } as const
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job])
    vi.mocked(listRecentLlmBatchJobs).mockResolvedValue([job])
    vi.mocked(getAllLlmBatchCapabilities).mockResolvedValue({})
    vi.mocked(readAuctionRecords).mockResolvedValue([])
    vi.mocked(isGeminiBatchTierPaid).mockReturnValue(true)
    vi.mocked(getTaskRunStatus).mockResolvedValue(IDLE_REPROCESS_STATUS)

    const handler = (await import('./llm-batch-jobs.get')).default as () => Promise<unknown>
    const result = (await handler()) as { jobs: Array<{ provider: string }> }

    expect(result.jobs[0]?.provider).toBe('openrouter')
  })

  it('synthesizes a config-gated gemini-native capability when the free tier has never been attempted', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { listPendingLlmBatchJobs, listRecentLlmBatchJobs, getAllLlmBatchCapabilities } =
      await import('~/server/utils/llm-batch-jobs')
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { isGeminiBatchTierPaid } = await import('~/server/utils/extract/gemini-batch')
    const { getTaskRunStatus } = await import('~/server/utils/task-runs')
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([])
    vi.mocked(listRecentLlmBatchJobs).mockResolvedValue([])
    vi.mocked(getAllLlmBatchCapabilities).mockResolvedValue({})
    vi.mocked(readAuctionRecords).mockResolvedValue([])
    vi.mocked(isGeminiBatchTierPaid).mockReturnValue(false)
    vi.mocked(getTaskRunStatus).mockResolvedValue(IDLE_REPROCESS_STATUS)

    const handler = (await import('./llm-batch-jobs.get')).default as () => Promise<unknown>
    const result = (await handler()) as { capabilities: Record<string, { ok: boolean; source: string }> }

    expect(result.capabilities['gemini-native']).toMatchObject({ ok: false, source: 'config' })
  })

  it('does not synthesize a gemini-native capability once the tier is paid', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { listPendingLlmBatchJobs, listRecentLlmBatchJobs, getAllLlmBatchCapabilities } =
      await import('~/server/utils/llm-batch-jobs')
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { isGeminiBatchTierPaid } = await import('~/server/utils/extract/gemini-batch')
    const { getTaskRunStatus } = await import('~/server/utils/task-runs')
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([])
    vi.mocked(listRecentLlmBatchJobs).mockResolvedValue([])
    vi.mocked(getAllLlmBatchCapabilities).mockResolvedValue({})
    vi.mocked(readAuctionRecords).mockResolvedValue([])
    vi.mocked(isGeminiBatchTierPaid).mockReturnValue(true)
    vi.mocked(getTaskRunStatus).mockResolvedValue(IDLE_REPROCESS_STATUS)

    const handler = (await import('./llm-batch-jobs.get')).default as () => Promise<unknown>
    const result = (await handler()) as { capabilities: Record<string, unknown> }

    expect(result.capabilities['gemini-native']).toBeUndefined()
  })

  it('passes the enrich task run status through unchanged', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { listPendingLlmBatchJobs, listRecentLlmBatchJobs, getAllLlmBatchCapabilities } =
      await import('~/server/utils/llm-batch-jobs')
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { isGeminiBatchTierPaid } = await import('~/server/utils/extract/gemini-batch')
    const { getTaskRunStatus } = await import('~/server/utils/task-runs')
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([])
    vi.mocked(listRecentLlmBatchJobs).mockResolvedValue([])
    vi.mocked(getAllLlmBatchCapabilities).mockResolvedValue({})
    vi.mocked(readAuctionRecords).mockResolvedValue([])
    vi.mocked(isGeminiBatchTierPaid).mockReturnValue(true)
    const runningStatus = {
      status: 'running' as const,
      startedAt: '2026-07-27T20:00:00.000Z',
      finishedAt: null,
      lastResult: null,
      lastError: null,
      lastWarning: null,
      lastLlmError: null,
      progress: null,
      progressByCountry: null,
    }
    vi.mocked(getTaskRunStatus).mockResolvedValue(runningStatus)

    const handler = (await import('./llm-batch-jobs.get')).default as () => Promise<unknown>
    const result = (await handler()) as { reprocessStatus: unknown }

    expect(result.reprocessStatus).toEqual(runningStatus)
  })

  it('caches the computed overview so rapid repeat polls skip the underlying scan', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { listPendingLlmBatchJobs, listRecentLlmBatchJobs, getAllLlmBatchCapabilities } =
      await import('~/server/utils/llm-batch-jobs')
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { isGeminiBatchTierPaid } = await import('~/server/utils/extract/gemini-batch')
    const { getTaskRunStatus } = await import('~/server/utils/task-runs')
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([])
    vi.mocked(listRecentLlmBatchJobs).mockResolvedValue([])
    vi.mocked(getAllLlmBatchCapabilities).mockResolvedValue({})
    vi.mocked(readAuctionRecords).mockResolvedValue([])
    vi.mocked(isGeminiBatchTierPaid).mockReturnValue(true)
    vi.mocked(getTaskRunStatus).mockResolvedValue(IDLE_REPROCESS_STATUS)

    const handler = (await import('./llm-batch-jobs.get')).default as () => Promise<unknown>
    await handler()
    await handler()

    expect(readAuctionRecords).toHaveBeenCalledTimes(1)
  })

  it('recomputes once the cache TTL has elapsed', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
      const { listPendingLlmBatchJobs, listRecentLlmBatchJobs, getAllLlmBatchCapabilities } =
        await import('~/server/utils/llm-batch-jobs')
      const { readAuctionRecords } = await import('~/server/utils/auction-record')
      const { isGeminiBatchTierPaid } = await import('~/server/utils/extract/gemini-batch')
      const { getTaskRunStatus } = await import('~/server/utils/task-runs')
      vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([])
      vi.mocked(listRecentLlmBatchJobs).mockResolvedValue([])
      vi.mocked(getAllLlmBatchCapabilities).mockResolvedValue({})
      vi.mocked(readAuctionRecords).mockResolvedValue([])
      vi.mocked(isGeminiBatchTierPaid).mockReturnValue(true)
      vi.mocked(getTaskRunStatus).mockResolvedValue(IDLE_REPROCESS_STATUS)

      const handler = (await import('./llm-batch-jobs.get')).default as () => Promise<unknown>
      await handler()
      vi.advanceTimersByTime(5000)
      await handler()

      expect(readAuctionRecords).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps the detailed jobs list without undercounting totalJobs/totalRequests', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { listPendingLlmBatchJobs, listRecentLlmBatchJobs, getAllLlmBatchCapabilities } =
      await import('~/server/utils/llm-batch-jobs')
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { isGeminiBatchTierPaid } = await import('~/server/utils/extract/gemini-batch')
    const { getTaskRunStatus } = await import('~/server/utils/task-runs')
    const manyPendingJobs = Array.from({ length: 60 }, (_, i) => ({
      jobName: `openrouter_batch_${i}`,
      source: 'reprocess' as const,
      status: 'pending' as const,
      itemCount: 1,
      customIdMap: {},
      submittedAt: '2026-08-08T18:00:00.000Z',
      checkedAt: null,
      updatedAt: '2026-08-08T18:00:00.000Z',
      errorMessage: null,
      provider: null,
      model: null,
      profileId: null,
    }))
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue(manyPendingJobs)
    vi.mocked(listRecentLlmBatchJobs).mockResolvedValue([])
    vi.mocked(getAllLlmBatchCapabilities).mockResolvedValue({})
    vi.mocked(readAuctionRecords).mockResolvedValue([])
    vi.mocked(isGeminiBatchTierPaid).mockReturnValue(true)
    vi.mocked(getTaskRunStatus).mockResolvedValue(IDLE_REPROCESS_STATUS)

    const handler = (await import('./llm-batch-jobs.get')).default as () => Promise<unknown>
    const result = (await handler()) as { totalJobs: number; totalRequests: number; jobs: unknown[] }

    expect(result.totalJobs).toBe(60)
    expect(result.totalRequests).toBe(60)
    expect(result.jobs).toHaveLength(50)
  })

  it('caps a single job\'s requestKeys without undercounting its pendingCount', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { listPendingLlmBatchJobs, listRecentLlmBatchJobs, getAllLlmBatchCapabilities } =
      await import('~/server/utils/llm-batch-jobs')
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { isGeminiBatchTierPaid } = await import('~/server/utils/extract/gemini-batch')
    const { getTaskRunStatus } = await import('~/server/utils/task-runs')
    const customIdMap = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`request_${i}`, `zvg-portal:${i}`]),
    )
    const job = {
      jobName: 'msgbatch_huge',
      source: 'reprocess' as const,
      status: 'pending' as const,
      itemCount: 500,
      customIdMap,
      submittedAt: '2026-08-08T18:00:00.000Z',
      checkedAt: null,
      updatedAt: '2026-08-08T18:00:00.000Z',
      errorMessage: null,
      provider: null,
      model: null,
      profileId: null,
    }
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([job])
    vi.mocked(listRecentLlmBatchJobs).mockResolvedValue([job])
    vi.mocked(getAllLlmBatchCapabilities).mockResolvedValue({})
    vi.mocked(readAuctionRecords).mockResolvedValue([])
    vi.mocked(isGeminiBatchTierPaid).mockReturnValue(true)
    vi.mocked(getTaskRunStatus).mockResolvedValue(IDLE_REPROCESS_STATUS)

    const handler = (await import('./llm-batch-jobs.get')).default as () => Promise<unknown>
    const result = (await handler()) as {
      jobs: Array<{ pendingCount: number; requestKeys: string[] }>
      recentJobs: Array<{ pendingCount: number; requestKeys: string[] }>
    }

    expect(result.jobs[0]?.pendingCount).toBe(500)
    expect(result.jobs[0]?.requestKeys).toHaveLength(200)
    expect(result.recentJobs[0]?.pendingCount).toBe(500)
    expect(result.recentJobs[0]?.requestKeys).toHaveLength(200)
  })
})
