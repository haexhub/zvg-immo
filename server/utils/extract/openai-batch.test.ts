import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmConfig } from './llm'

vi.mock('../llm-batch-jobs', () => ({
  insertLlmBatchJob: vi.fn().mockResolvedValue(true),
  recordLlmBatchCapability: vi.fn().mockResolvedValue(undefined),
}))

const config: LlmConfig = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-test',
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

describe('submitOpenAiBatch', () => {
  it('uploads JSONL, creates a chat-completions batch and records the custom_id map', async () => {
    stubOfetch([
      { match: '/files', data: { id: 'file-abc' } },
      { match: '/batches', data: { id: 'batch_abc' } },
    ])
    const { insertLlmBatchJob, recordLlmBatchCapability } = await import('../llm-batch-jobs')
    const { submitOpenAiBatch } = await import('./openai-batch')

    const result = await submitOpenAiBatch(
      [{ key: 'zvg-portal:7265', input: { title: 'Haus', description: 'Beschreibung', pdfText: 'PDF Text' } }],
      config,
      'enrich',
    )

    expect(result?.jobName).toBe('batch_abc')
    expect(recordLlmBatchCapability).toHaveBeenCalledWith('openai-compatible', { ok: true, message: null, source: 'enrich' })
    expect(result?.submitted).toEqual([{ key: 'zvg-portal:7265', jobName: 'batch_abc' }])
    expect(result?.retryItems).toEqual([])
    expect(vi.mocked($fetch)).toHaveBeenCalledWith(
      'https://api.openai.com/v1/files',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
    )
    const createCall = vi.mocked($fetch).mock.calls.find(([url]) => (url as string).endsWith('/batches'))
    expect((createCall?.[1] as { body: Record<string, unknown> })?.body).toMatchObject({
      input_file_id: 'file-abc',
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    })
    const recorded = vi.mocked(insertLlmBatchJob).mock.calls[0]?.[0]
    expect(recorded).toMatchObject({ jobName: 'batch_abc', source: 'enrich', itemCount: 1 })
    expect(Object.values(recorded?.customIdMap ?? {})).toEqual(['zvg-portal:7265'])
  })

  it('returns a single real job id while keeping per-chunk job ids on submitted items', async () => {
    const byteLength = vi.spyOn(Buffer, 'byteLength').mockReturnValue(100 * 1024 * 1024)
    stubOfetch([
      { match: '/files', data: { id: 'file-a' } },
      { match: '/batches', data: { id: 'batch_a' } },
      { match: '/files', data: { id: 'file-b' } },
      { match: '/batches', data: { id: 'batch_b' } },
    ])
    const { submitOpenAiBatch } = await import('./openai-batch')

    const result = await submitOpenAiBatch(
      [
        { key: 'one', input: { title: 'Haus eins', description: null } },
        { key: 'two', input: { title: 'Haus zwei', description: null } },
      ],
      config,
      'enrich',
    )

    expect(result?.jobName).toBe('batch_a')
    expect(result?.submitted).toEqual([
      { key: 'one', jobName: 'batch_a' },
      { key: 'two', jobName: 'batch_b' },
    ])
    expect(result?.retryItems).toEqual([])
    expect(byteLength).toHaveBeenCalled()
  })

  it('cancels an OpenAI batch when local job recording fails', async () => {
    stubOfetch([
      { match: '/files', data: { id: 'file-abc' } },
      { match: '/batches', data: { id: 'batch_abc' } },
      { match: '/batches/batch_abc/cancel', data: { id: 'batch_abc', status: 'cancelling' } },
    ])
    const { insertLlmBatchJob } = await import('../llm-batch-jobs')
    vi.mocked(insertLlmBatchJob).mockResolvedValueOnce(false)
    const { submitOpenAiBatch } = await import('./openai-batch')

    await expect(submitOpenAiBatch(
      [{ key: 'zvg-portal:7265', input: { title: 'Haus', description: 'Beschreibung' } }],
      config,
      'enrich',
    )).resolves.toBeNull()

    expect(vi.mocked($fetch)).toHaveBeenCalledWith(
      'https://api.openai.com/v1/batches/batch_abc/cancel',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('returns null when the upload response has no file id', async () => {
    stubOfetch([{ match: '/files', data: {} }])
    const { insertLlmBatchJob, recordLlmBatchCapability } = await import('../llm-batch-jobs')
    const { submitOpenAiBatch } = await import('./openai-batch')

    await expect(submitOpenAiBatch([{ key: 'x:y', input: { title: 'Haus', description: null } }], config, 'enrich'))
      .resolves.toBeNull()
    expect(insertLlmBatchJob).not.toHaveBeenCalled()
    expect(recordLlmBatchCapability).toHaveBeenCalledWith('openai-compatible', {
      ok: false,
      message: 'file upload response had no file id',
      source: 'enrich',
    })
  })

  it('records the real error body as capability ok:false on a rejected submit', async () => {
    stubOfetch([
      { match: '/files', data: { id: 'file-abc' } },
      {
        match: '/batches',
        error: Object.assign(new Error('[POST] "...": 400 Bad Request'), {
          data: { error: { message: 'Invalid model.' } },
        }),
      },
    ])
    const { recordLlmBatchCapability } = await import('../llm-batch-jobs')
    const { submitOpenAiBatch } = await import('./openai-batch')

    await expect(
      submitOpenAiBatch([{ key: 'x:y', input: { title: 'Haus', description: null } }], config, 'enrich'),
    ).resolves.toBeNull()
    expect(recordLlmBatchCapability).toHaveBeenCalledWith('openai-compatible', {
      ok: false,
      message: 'Invalid model.',
      source: 'enrich',
    })
  })

  it('does not flip capability to broken on a transient connection error', async () => {
    stubOfetch([
      { match: '/files', data: { id: 'file-abc' } },
      {
        match: '/batches',
        error: Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }),
      },
    ])
    const { recordLlmBatchCapability } = await import('../llm-batch-jobs')
    const { submitOpenAiBatch } = await import('./openai-batch')

    await expect(
      submitOpenAiBatch([{ key: 'x:y', input: { title: 'Haus', description: null } }], config, 'enrich'),
    ).resolves.toBeNull()
    expect(recordLlmBatchCapability).not.toHaveBeenCalled()
  })
})

describe('pollOpenAiBatch', () => {
  it('maps completed to succeeded with the output file id', async () => {
    stubOfetch([{ match: '/batches/batch_abc', data: { status: 'completed', output_file_id: 'file-out' } }])
    const { pollOpenAiBatch } = await import('./openai-batch')

    await expect(pollOpenAiBatch('batch_abc', config)).resolves.toEqual({
      state: 'succeeded',
      resultFileName: 'file-out',
    })
  })

  it('maps terminal and in-flight statuses', async () => {
    stubOfetch([
      { match: '/batches/batch_failed', data: { status: 'failed' } },
      { match: '/batches/batch_expired', data: { status: 'expired' } },
      { match: '/batches/batch_running', data: { status: 'in_progress' } },
    ])
    const { pollOpenAiBatch } = await import('./openai-batch')

    await expect(pollOpenAiBatch('batch_failed', config)).resolves.toEqual({ state: 'failed' })
    await expect(pollOpenAiBatch('batch_expired', config)).resolves.toEqual({ state: 'expired' })
    await expect(pollOpenAiBatch('batch_running', config)).resolves.toEqual({ state: 'pending' })
  })
})

describe('fetchOpenAiBatchResults', () => {
  it('maps successful and failed JSONL result lines back through custom_id', async () => {
    const lines = [
      JSON.stringify({
        custom_id: 'zvg_0_hash',
        response: {
          status_code: 200,
          body: {
            choices: [{ message: { content: '{"propertyType":"einfamilienhaus","landAreaSqm":500,"photos":[]}' } }],
          },
        },
        error: null,
      }),
      JSON.stringify({ custom_id: 'zvg_1_hash', response: null, error: { code: 'batch_expired' } }),
    ]
    stubOfetch([{ match: '/files/file-out/content', data: lines.join('\n') }])
    const { fetchOpenAiBatchResults } = await import('./openai-batch')

    const results = await fetchOpenAiBatchResults('file-out', config, {
      zvg_0_hash: 'zvg-portal:7265',
      zvg_1_hash: 'zvg-portal:9999',
    })

    expect(results).toHaveLength(2)
    expect(results[0]!.key).toBe('zvg-portal:7265')
    expect(results[0]!.extraction?.propertyType).toBe('einfamilienhaus')
    expect(results[0]!.extraction?.landAreaSqm).toBe(500)
    expect(results[0]!.usage).toEqual({ inputTokens: null, outputTokens: null })
    expect(results[1]).toEqual({ key: 'zvg-portal:9999', extraction: null, usage: null, error: 'Keine gültige Extraktion in der Batch-Antwort' })
  })
})
