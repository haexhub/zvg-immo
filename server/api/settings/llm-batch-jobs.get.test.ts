import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/llm-batch-jobs', () => ({
  listPendingLlmBatchJobs: vi.fn(),
  listRecentLlmBatchJobs: vi.fn(),
  getAllLlmBatchCapabilities: vi.fn(),
}))
vi.mock('~/server/utils/extraction-cache', () => ({ readExtractionCache: vi.fn() }))

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
    const { readExtractionCache } = await import('~/server/utils/extraction-cache')
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
      },
    ])
    vi.mocked(getAllLlmBatchCapabilities).mockResolvedValue({
      'gemini-native': { ok: false, message: 'FAILED_PRECONDITION: Precondition check failed.', checkedAt: '2026-07-26T18:00:00.000Z', source: 'enrich' },
    })
    vi.mocked(readExtractionCache).mockResolvedValue({
      'zvg-portal:1': { llmBatchJob: 'msgbatch_abc', at: '2026-07-26T18:00:00.000Z' } as never,
      'zvg-portal:2': { llmBatchJob: 'msgbatch_abc', at: '2026-07-26T18:00:00.000Z' } as never,
      'zvg-portal:3': { at: '2026-07-26T18:00:00.000Z' } as never,
      'zvg-portal:4': { source: 'rules', confidence: 'low', at: '2026-07-26T18:00:00.000Z' } as never,
      'zvg-portal:5': { llmBatchJob: 'deleted_job', at: '2026-07-26T18:00:00.000Z' } as never,
    })

    const handler = (await import('./llm-batch-jobs.get')).default as () => Promise<unknown>

    await expect(handler()).resolves.toEqual({
      totalJobs: 1,
      totalRequests: 2,
      backlog: {
        readyRequests: 2,
        lowConfidenceRules: 1,
        missingLlmFields: 2,
        orphanedBatchMarkers: 1,
        failedLimit: 0,
        sampleRequestKeys: ['zvg-portal:3', 'zvg-portal:4'],
        orphanedRequestKeys: ['zvg-portal:5'],
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
    })
  })
})
