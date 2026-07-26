import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/llm-batch-jobs', () => ({ listPendingLlmBatchJobs: vi.fn() }))
vi.mock('~/server/utils/extraction-cache', () => ({ readExtractionCache: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/llm-batch-jobs', () => {
  it('summarizes pending jobs and their waiting request keys', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { listPendingLlmBatchJobs } = await import('~/server/utils/llm-batch-jobs')
    const { readExtractionCache } = await import('~/server/utils/extraction-cache')
    vi.mocked(listPendingLlmBatchJobs).mockResolvedValue([
      {
        jobName: 'msgbatch_abc',
        source: 'reprocess',
        status: 'pending',
        itemCount: 2,
        customIdMap: { request_0: 'zvg-portal:1' },
        submittedAt: '2026-07-26T18:00:00.000Z',
        checkedAt: null,
        updatedAt: '2026-07-26T18:00:00.000Z',
      },
    ])
    vi.mocked(readExtractionCache).mockResolvedValue({
      'zvg-portal:1': { llmBatchJob: 'msgbatch_abc', at: '2026-07-26T18:00:00.000Z' } as never,
      'zvg-portal:2': { llmBatchJob: 'msgbatch_abc', at: '2026-07-26T18:00:00.000Z' } as never,
      'zvg-portal:3': { at: '2026-07-26T18:00:00.000Z' } as never,
    })

    const handler = (await import('./llm-batch-jobs.get')).default as () => Promise<unknown>

    await expect(handler()).resolves.toEqual({
      totalJobs: 1,
      totalRequests: 2,
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
        },
      ],
    })
  })
})
