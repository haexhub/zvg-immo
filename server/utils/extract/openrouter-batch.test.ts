import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmConfig } from './llm'

vi.mock('../llm-batch-jobs', () => ({
  insertLlmBatchJob: vi.fn().mockResolvedValue(true),
  recordLlmBatchCapability: vi.fn().mockResolvedValue(undefined),
}))

const config: LlmConfig = {
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-test',
  model: 'google/gemini-3.5-flash-lite',
  maxTokens: 2048,
}

function stubOfetch(handlers: Array<{ match: string; data?: unknown; error?: Error }>) {
  const fetchFn = vi.fn(async (url: string) => {
    const index = handlers.findIndex((h) => url.includes(h.match))
    const h = index >= 0 ? handlers.splice(index, 1)[0] : null
    if (!h) throw new Error(`unstubbed URL: ${url}`)
    if (h.error) throw h.error
    return h.data
  }) as unknown as typeof $fetch
  vi.stubGlobal('$fetch', fetchFn)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('submitOpenRouterBatch', () => {
  it('posts to the beta batches endpoint and wraps the returned id', async () => {
    stubOfetch([{ match: '/api/beta/batches', data: { id: 'batch_abc' } }])
    const { insertLlmBatchJob, recordLlmBatchCapability } = await import('../llm-batch-jobs')
    const { submitOpenRouterBatch } = await import('./openrouter-batch')

    const result = await submitOpenRouterBatch(
      [{ key: 'zvg-portal:7265', input: { title: 'Haus', description: 'Beschreibung', pdfText: 'PDF Text' } }],
      config,
      'reprocess',
    )

    expect(result?.jobName).toBe('openrouter_batch_abc')
    expect(result?.submitted).toEqual([{ key: 'zvg-portal:7265', jobName: 'openrouter_batch_abc' }])
    expect(result?.retryItems).toEqual([])
    expect(recordLlmBatchCapability).toHaveBeenCalledWith('openrouter', { ok: true, message: null, source: 'reprocess' })
    expect(vi.mocked($fetch)).toHaveBeenCalledWith(
      'https://openrouter.ai/api/beta/batches',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ endpoint: '/v1/chat/completions', model: 'google/gemini-3.5-flash-lite' }),
      }),
    )
    const recorded = vi.mocked(insertLlmBatchJob).mock.calls[0]?.[0]
    expect(recorded).toMatchObject({ jobName: 'openrouter_batch_abc', source: 'reprocess', itemCount: 1 })
    expect(Object.values(recorded?.customIdMap ?? {})).toEqual(['zvg-portal:7265'])
  })

  it('skips an item with image content into retryItems instead of submitting it', async () => {
    stubOfetch([{ match: '/api/beta/batches', data: { id: 'batch_abc' } }])
    const { submitOpenRouterBatch } = await import('./openrouter-batch')

    const textItem = { key: 'zvg-portal:1', input: { title: 'Haus', description: null } }
    const imageItem = {
      key: 'zvg-portal:2',
      input: { title: 'Haus 2', description: null, candidateImages: [{ label: 'a.jpg', mimeType: 'image/jpeg', data: 'xx' }] },
    }
    const result = await submitOpenRouterBatch([textItem, imageItem], config, 'reprocess')

    expect(result?.submitted).toEqual([{ key: 'zvg-portal:1', jobName: 'openrouter_batch_abc' }])
    expect(result?.retryItems).toEqual([imageItem])
  })

  it('returns null without an apiKey', async () => {
    const { submitOpenRouterBatch } = await import('./openrouter-batch')
    await expect(
      submitOpenRouterBatch([{ key: 'x:y', input: { title: 'Haus', description: null } }], { ...config, apiKey: undefined }, 'reprocess'),
    ).resolves.toBeNull()
  })

  it('returns null and records capability false when the response has no batch id', async () => {
    stubOfetch([{ match: '/api/beta/batches', data: {} }])
    const { insertLlmBatchJob, recordLlmBatchCapability } = await import('../llm-batch-jobs')
    const { submitOpenRouterBatch } = await import('./openrouter-batch')

    await expect(
      submitOpenRouterBatch([{ key: 'x:y', input: { title: 'Haus', description: null } }], config, 'reprocess'),
    ).resolves.toBeNull()
    expect(insertLlmBatchJob).not.toHaveBeenCalled()
    expect(recordLlmBatchCapability).toHaveBeenCalledWith('openrouter', {
      ok: false,
      message: 'create response had no batch id',
      source: 'reprocess',
    })
  })

  it('records the real error body as capability ok:false on a rejected submit', async () => {
    stubOfetch([
      {
        match: '/api/beta/batches',
        error: Object.assign(new Error('[POST] "...": 400 Bad Request'), {
          data: { error: { message: 'Invalid model.' } },
        }),
      },
    ])
    const { recordLlmBatchCapability } = await import('../llm-batch-jobs')
    const { submitOpenRouterBatch } = await import('./openrouter-batch')

    await expect(
      submitOpenRouterBatch([{ key: 'x:y', input: { title: 'Haus', description: null } }], config, 'reprocess'),
    ).resolves.toBeNull()
    expect(recordLlmBatchCapability).toHaveBeenCalledWith('openrouter', {
      ok: false,
      message: 'Invalid model.',
      source: 'reprocess',
    })
  })

  it('does not flip capability to broken on a transient connection error', async () => {
    stubOfetch([
      {
        match: '/api/beta/batches',
        error: Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }),
      },
    ])
    const { recordLlmBatchCapability } = await import('../llm-batch-jobs')
    const { submitOpenRouterBatch } = await import('./openrouter-batch')

    await expect(
      submitOpenRouterBatch([{ key: 'x:y', input: { title: 'Haus', description: null } }], config, 'reprocess'),
    ).resolves.toBeNull()
    expect(recordLlmBatchCapability).not.toHaveBeenCalled()
  })
})

describe('pollOpenRouterBatch', () => {
  it('maps completed/failed/expired/pending statuses and strips the internal prefix from the URL', async () => {
    stubOfetch([
      { match: '/api/beta/batches/batch_ok', data: { status: 'completed' } },
      { match: '/api/beta/batches/batch_failed', data: { status: 'failed', error: { message: 'boom' } } },
      { match: '/api/beta/batches/batch_expired', data: { status: 'expired' } },
      { match: '/api/beta/batches/batch_running', data: { status: 'in_progress' } },
    ])
    const { pollOpenRouterBatch } = await import('./openrouter-batch')

    await expect(pollOpenRouterBatch('openrouter_batch_ok', config)).resolves.toEqual({ state: 'succeeded' })
    await expect(pollOpenRouterBatch('openrouter_batch_failed', config)).resolves.toEqual({ state: 'failed', errorMessage: 'boom' })
    await expect(pollOpenRouterBatch('openrouter_batch_expired', config)).resolves.toEqual({ state: 'expired', errorMessage: undefined })
    await expect(pollOpenRouterBatch('openrouter_batch_running', config)).resolves.toEqual({ state: 'pending' })
  })

  it('treats a poll failure as pending rather than throwing', async () => {
    stubOfetch([{ match: '/api/beta/batches/batch_x', error: new Error('network down') }])
    const { pollOpenRouterBatch } = await import('./openrouter-batch')
    await expect(pollOpenRouterBatch('openrouter_batch_x', config)).resolves.toEqual({ state: 'pending' })
  })
})

describe('fetchOpenRouterBatchResults', () => {
  it('maps inline results back through custom_id, treating errors/non-200 as a null extraction', async () => {
    stubOfetch([
      {
        match: '/api/beta/batches/batch_ok',
        data: {
          results: [
            {
              custom_id: 'zvg_0_hash',
              response: {
                status_code: 200,
                body: {
                  choices: [{ message: { content: '{"propertyType":"einfamilienhaus","landAreaSqm":500,"photos":[]}' } }],
                },
              },
              error: null,
            },
            { custom_id: 'zvg_1_hash', response: { status_code: 500, body: null }, error: { message: 'failed' } },
          ],
        },
      },
    ])
    const { fetchOpenRouterBatchResults } = await import('./openrouter-batch')

    const results = await fetchOpenRouterBatchResults('openrouter_batch_ok', config, {
      zvg_0_hash: 'zvg-portal:7265',
      zvg_1_hash: 'zvg-portal:9999',
    })

    expect(results).toHaveLength(2)
    expect(results[0]!.key).toBe('zvg-portal:7265')
    expect(results[0]!.extraction?.propertyType).toBe('einfamilienhaus')
    expect(results[0]!.extraction?.landAreaSqm).toBe(500)
    expect(results[0]!.usage).toEqual({ inputTokens: null, outputTokens: null })
    expect(results[1]).toEqual({ key: 'zvg-portal:9999', extraction: null, usage: null, error: 'failed' })
  })

  it('returns an empty array when the fetch fails', async () => {
    stubOfetch([{ match: '/api/beta/batches/batch_x', error: new Error('network down') }])
    const { fetchOpenRouterBatchResults } = await import('./openrouter-batch')
    await expect(fetchOpenRouterBatchResults('openrouter_batch_x', config, {})).resolves.toEqual([])
  })
})
