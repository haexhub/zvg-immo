import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmConfig } from './llm'

vi.mock('../llm-batch-jobs', () => ({
  insertLlmBatchJob: vi.fn().mockResolvedValue(true),
  recordLlmBatchCapability: vi.fn().mockResolvedValue(undefined),
}))

const config: LlmConfig = {
  provider: 'claude-proxy',
  baseUrl: 'http://haex-claude-proxy:8080',
  apiKey: 'proxy-session-token',
  model: 'claude-haiku-4-5',
  maxTokens: 2048,
}

function stubOfetch(handlers: Array<{ match: string; data?: unknown; error?: Error }>) {
  const fetchFn = vi.fn(async (url: string) => {
    const h = handlers.find((h) => url.includes(h.match))
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

describe('submitAnthropicBatch', () => {
  it('submits Messages requests and records the custom_id map', async () => {
    stubOfetch([{ match: '/v1/messages/batches', data: { id: 'msgbatch_abc' } }])
    const { insertLlmBatchJob, recordLlmBatchCapability } = await import('../llm-batch-jobs')
    const { submitAnthropicBatch } = await import('./anthropic-batch')

    const result = await submitAnthropicBatch(
      [
        {
          key: 'zvg-portal:7265',
          input: {
            title: 'Haus',
            description: 'Beschreibung',
            pdfDocuments: [{ label: 'Gutachten', data: 'JVBERi0xLjQ=' }],
          },
        },
      ],
      config,
      'enrich',
    )

    expect(result?.jobName).toBe('msgbatch_abc')
    expect(result?.submitted).toEqual([{ key: 'zvg-portal:7265', jobName: 'msgbatch_abc' }])
    expect(result?.retryItems).toEqual([])
    const [url, opts] = vi.mocked($fetch).mock.calls[0]!
    expect(url).toBe('http://haex-claude-proxy:8080/v1/messages/batches')
    expect((opts as { headers: Record<string, string> }).headers['x-api-key']).toBe('proxy-session-token')
    const body = (opts as { body: { requests: Array<{ custom_id: string; params: Record<string, unknown> }> } }).body
    expect(body.requests).toHaveLength(1)
    expect(body.requests[0]!.custom_id).toMatch(/^zvg_0_[A-Za-z0-9_-]+$/)
    expect(body.requests[0]!.params).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      tool_choice: { type: 'tool', name: 'final_result' },
    })
    const content = (body.requests[0]!.params.messages as Array<{ content: unknown[] }>)[0]!.content
    expect(content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'document', source: expect.objectContaining({ media_type: 'application/pdf' }) }),
      ]),
    )
    expect(insertLlmBatchJob).toHaveBeenCalledWith({
      jobName: 'msgbatch_abc',
      source: 'enrich',
      itemCount: 1,
      customIdMap: { [body.requests[0]!.custom_id]: 'zvg-portal:7265' },
    })
    expect(recordLlmBatchCapability).toHaveBeenCalledWith('claude-proxy', { ok: true, message: null, source: 'enrich' })
  })

  it('returns null when the create response has no id', async () => {
    stubOfetch([{ match: '/v1/messages/batches', data: {} }])
    const { insertLlmBatchJob, recordLlmBatchCapability } = await import('../llm-batch-jobs')
    const { submitAnthropicBatch } = await import('./anthropic-batch')

    await expect(submitAnthropicBatch([{ key: 'x:y', input: { title: 'Haus', description: null } }], config, 'enrich'))
      .resolves.toBeNull()
    expect(insertLlmBatchJob).not.toHaveBeenCalled()
    expect(recordLlmBatchCapability).toHaveBeenCalledWith('claude-proxy', {
      ok: false,
      message: 'create response had no batch id',
      source: 'enrich',
    })
  })

  it('records the real error body as capability ok:false on a rejected submit', async () => {
    stubOfetch([
      {
        match: '/v1/messages/batches',
        error: Object.assign(new Error('[POST] "...": 400 Bad Request'), {
          data: { error: { type: 'invalid_request_error', message: 'model: field required' } },
        }),
      },
    ])
    const { recordLlmBatchCapability } = await import('../llm-batch-jobs')
    const { submitAnthropicBatch } = await import('./anthropic-batch')

    await expect(
      submitAnthropicBatch([{ key: 'x:y', input: { title: 'Haus', description: null } }], config, 'enrich'),
    ).resolves.toBeNull()
    expect(recordLlmBatchCapability).toHaveBeenCalledWith('claude-proxy', {
      ok: false,
      message: 'model: field required',
      source: 'enrich',
    })
  })

  it('splits requests before the serialized batch body reaches Anthropic limits', async () => {
    vi.stubGlobal('$fetch', vi.fn()
      .mockResolvedValueOnce({ id: 'msgbatch_a' })
      .mockResolvedValueOnce({ id: 'msgbatch_b' }))
    const realByteLength = Buffer.byteLength
    vi.spyOn(Buffer, 'byteLength').mockImplementation((value: Parameters<typeof Buffer.byteLength>[0], encoding?: BufferEncoding) => {
      const text = typeof value === 'string' ? value : ''
      if (text.includes('Haus 1') || text.includes('Haus 2')) return 255 * 1024 * 1024
      return realByteLength(value, encoding)
    })
    const { insertLlmBatchJob } = await import('../llm-batch-jobs')
    const { submitAnthropicBatch } = await import('./anthropic-batch')

    const result = await submitAnthropicBatch([
      { key: 'one', input: { title: 'Haus 1', description: 'Beschreibung eins' } },
      { key: 'two', input: { title: 'Haus 2', description: 'Beschreibung zwei' } },
    ], config, 'enrich')

    expect(result?.jobName).toBe('msgbatch_a,msgbatch_b')
    expect(result?.submitted).toEqual([
      { key: 'one', jobName: 'msgbatch_a' },
      { key: 'two', jobName: 'msgbatch_b' },
    ])
    expect(result?.retryItems).toEqual([])
    expect(vi.mocked($fetch)).toHaveBeenCalledTimes(2)
    expect(insertLlmBatchJob).toHaveBeenCalledTimes(2)
    expect(vi.mocked(insertLlmBatchJob).mock.calls.map(([arg]) => arg.itemCount)).toEqual([1, 1])
  })

  it('surfaces partial progress when a later chunk fails after an earlier chunk was submitted', async () => {
    vi.stubGlobal('$fetch', vi.fn()
      .mockResolvedValueOnce({ id: 'msgbatch_a' })
      .mockRejectedValueOnce(new Error('timeout')))
    const realByteLength = Buffer.byteLength
    vi.spyOn(Buffer, 'byteLength').mockImplementation((value: Parameters<typeof Buffer.byteLength>[0], encoding?: BufferEncoding) => {
      const text = typeof value === 'string' ? value : ''
      if (text.includes('Haus 1') || text.includes('Haus 2')) return 255 * 1024 * 1024
      return realByteLength(value, encoding)
    })
    const { insertLlmBatchJob } = await import('../llm-batch-jobs')
    const { submitAnthropicBatch } = await import('./anthropic-batch')
    const retryItem = { key: 'two', input: { title: 'Haus 2', description: 'Beschreibung zwei' } }

    const result = await submitAnthropicBatch([
      { key: 'one', input: { title: 'Haus 1', description: 'Beschreibung eins' } },
      retryItem,
    ], config, 'enrich')

    expect(result?.jobName).toBe('msgbatch_a')
    expect(result?.submitted).toEqual([{ key: 'one', jobName: 'msgbatch_a' }])
    expect(result?.retryItems).toEqual([retryItem])
    expect(insertLlmBatchJob).toHaveBeenCalledTimes(1)
    expect(vi.mocked(insertLlmBatchJob).mock.calls[0]?.[0].itemCount).toBe(1)
  })
})

describe('pollAnthropicBatch', () => {
  it('maps ended to succeeded and in_progress to pending', async () => {
    stubOfetch([
      { match: '/msgbatch_done', data: { processing_status: 'ended' } },
      { match: '/msgbatch_wait', data: { processing_status: 'in_progress' } },
    ])
    const { pollAnthropicBatch } = await import('./anthropic-batch')

    await expect(pollAnthropicBatch('msgbatch_done', config)).resolves.toEqual({ state: 'succeeded' })
    await expect(pollAnthropicBatch('msgbatch_wait', config)).resolves.toEqual({ state: 'pending' })
  })
})

describe('fetchAnthropicBatchResults', () => {
  it('maps JSONL results back through custom_id and clamps the tool result', async () => {
    const lines = [
      JSON.stringify({
        custom_id: 'zvg_0_hash',
        result: {
          type: 'succeeded',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'final_result',
                input: { propertyType: 'einfamilienhaus', landAreaSqm: 500, photos: [] },
              },
            ],
          },
        },
      }),
      JSON.stringify({ custom_id: 'zvg_1_hash', result: { type: 'errored', error: { type: 'invalid_request_error' } } }),
    ]
    stubOfetch([{ match: '/msgbatch_abc/results', data: lines.join('\n') }])
    const { fetchAnthropicBatchResults } = await import('./anthropic-batch')

    const results = await fetchAnthropicBatchResults('msgbatch_abc', config, {
      zvg_0_hash: 'zvg-portal:7265',
      zvg_1_hash: 'zvg-portal:9999',
    })

    expect(results).toHaveLength(2)
    expect(results[0]!.key).toBe('zvg-portal:7265')
    expect(results[0]!.extraction?.propertyType).toBe('einfamilienhaus')
    expect(results[0]!.extraction?.landAreaSqm).toBe(500)
    expect(results[1]).toEqual({ key: 'zvg-portal:9999', extraction: null })
  })

  it('lets transport errors propagate to the poller retry path', async () => {
    stubOfetch([{ match: '/msgbatch_abc/results', error: new Error('timeout') }])
    const { fetchAnthropicBatchResults } = await import('./anthropic-batch')

    await expect(fetchAnthropicBatchResults('msgbatch_abc', config, {})).rejects.toThrow('timeout')
  })
})
