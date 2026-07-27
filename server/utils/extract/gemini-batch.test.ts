import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmConfig } from './llm'

vi.mock('../llm-batch-jobs', () => ({ insertLlmBatchJob: vi.fn().mockResolvedValue(true) }))

const config: LlmConfig = {
  provider: 'gemini-native',
  baseUrl: 'https://generativelanguage.googleapis.com',
  apiKey: 'test-key',
  model: 'gemini-flash-latest',
}

/** Routes `$fetch`/`$fetch.raw` calls by matching a URL substring, in
 *  registration order — same spirit as native-images.test.ts's stubFetch,
 *  adapted for ofetch's callable-with-.raw shape. */
function stubOfetch(handlers: Array<{ match: string; raw?: { headers?: Record<string, string>; data?: unknown }; data?: unknown; error?: Error }>) {
  const find = (url: string) => {
    const h = handlers.find((h) => url.includes(h.match))
    if (!h) throw new Error(`unstubbed URL: ${url}`)
    return h
  }
  const fetchFn = vi.fn(async (url: string) => {
    const h = find(url)
    if (h.error) throw h.error
    return h.data
  }) as unknown as typeof $fetch
  ;(fetchFn as unknown as { raw: (url: string) => Promise<unknown> }).raw = vi.fn(async (url: string) => {
    const h = find(url)
    if (h.error) throw h.error
    return {
      headers: new Map(Object.entries(h.raw?.headers ?? {})) as unknown as Headers,
      _data: h.raw?.data,
    }
  })
  vi.stubGlobal('$fetch', fetchFn)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('submitGeminiBatch', () => {
  it('uploads the JSONL, submits the batch and records the job', async () => {
    stubOfetch([
      { match: '/upload/v1beta/files', raw: { headers: { 'x-goog-upload-url': 'https://upload.example/session-1' } } },
      { match: 'upload.example/session-1', data: { file: { name: 'files/abc' } } },
      { match: ':batchGenerateContent', data: { name: 'batches/xyz' } },
    ])
    const { insertLlmBatchJob } = await import('../llm-batch-jobs')
    const { submitGeminiBatch } = await import('./gemini-batch')

    const jobName = await submitGeminiBatch(
      [{ key: 'zvg-portal:1', input: { title: 'Haus', description: 'schön', pdfText: null } }],
      config,
      'enrich',
    )

    expect(jobName).toBe('batches/xyz')
    expect(insertLlmBatchJob).toHaveBeenCalledWith({
      jobName: 'batches/xyz',
      source: 'enrich',
      itemCount: 1,
      customIdMap: { '0': 'zvg-portal:1' },
    })
    const submitCall = vi.mocked($fetch).mock.calls.find(([url]) => (url as string).includes(':batchGenerateContent'))
    expect((submitCall?.[1] as { body: unknown })?.body).toEqual({
      batch: { display_name: 'zvg-immo-enrich', input_config: { file_name: 'files/abc' } },
    })
  })

  it('returns null and does not record the job when insertLlmBatchJob fails to persist it', async () => {
    stubOfetch([
      { match: '/upload/v1beta/files', raw: { headers: { 'x-goog-upload-url': 'https://upload.example/session-1' } } },
      { match: 'upload.example/session-1', data: { file: { name: 'files/abc' } } },
      { match: ':batchGenerateContent', data: { name: 'batches/xyz' } },
    ])
    const { insertLlmBatchJob } = await import('../llm-batch-jobs')
    vi.mocked(insertLlmBatchJob).mockResolvedValueOnce(false)
    const { submitGeminiBatch } = await import('./gemini-batch')

    const jobName = await submitGeminiBatch(
      [{ key: 'zvg-portal:1', input: { title: 'Haus', description: 'schön', pdfText: null } }],
      config,
      'enrich',
    )

    expect(jobName).toBeNull()
  })

  it('returns null without submitting anything when no item has content', async () => {
    const { insertLlmBatchJob } = await import('../llm-batch-jobs')
    const { submitGeminiBatch } = await import('./gemini-batch')

    const jobName = await submitGeminiBatch(
      [{ key: 'zvg-portal:1', input: { title: null, description: null, pdfText: null } }],
      config,
      'enrich',
    )

    expect(jobName).toBeNull()
    expect(insertLlmBatchJob).not.toHaveBeenCalled()
  })

  it('returns null when the resumable upload never yields an upload URL', async () => {
    stubOfetch([{ match: '/upload/v1beta/files', raw: { headers: {} } }])
    const { submitGeminiBatch } = await import('./gemini-batch')

    const jobName = await submitGeminiBatch(
      [{ key: 'zvg-portal:1', input: { title: 'Haus', description: null, pdfText: null } }],
      config,
      'enrich',
    )

    expect(jobName).toBeNull()
  })

  it('returns null when batchGenerateContent responds without a job name', async () => {
    stubOfetch([
      { match: '/upload/v1beta/files', raw: { headers: { 'x-goog-upload-url': 'https://upload.example/session-1' } } },
      { match: 'upload.example/session-1', data: { file: { name: 'files/abc' } } },
      { match: ':batchGenerateContent', data: {} },
    ])
    const { insertLlmBatchJob } = await import('../llm-batch-jobs')
    const { submitGeminiBatch } = await import('./gemini-batch')

    const jobName = await submitGeminiBatch(
      [{ key: 'zvg-portal:1', input: { title: 'Haus', description: null, pdfText: null } }],
      config,
      'enrich',
    )

    expect(jobName).toBeNull()
    expect(insertLlmBatchJob).not.toHaveBeenCalled()
  })

  it('returns null when the upload request throws', async () => {
    stubOfetch([{ match: '/upload/v1beta/files', error: new Error('network down') }])
    const { submitGeminiBatch } = await import('./gemini-batch')

    const jobName = await submitGeminiBatch(
      [{ key: 'zvg-portal:1', input: { title: 'Haus', description: null, pdfText: null } }],
      config,
      'enrich',
    )

    expect(jobName).toBeNull()
  })
})

describe('pollGeminiBatch', () => {
  it('reports succeeded with the result file name (metadata.state + response.output.responsesFile path)', async () => {
    stubOfetch([
      {
        match: '/v1beta/batches/xyz',
        data: { metadata: { state: 'JOB_STATE_SUCCEEDED' }, response: { output: { responsesFile: 'files/results' } } },
      },
    ])
    const { pollGeminiBatch } = await import('./gemini-batch')

    await expect(pollGeminiBatch('batches/xyz', config)).resolves.toEqual({
      state: 'succeeded',
      resultFileName: 'files/results',
    })
  })

  it('falls back to a bare top-level state field', async () => {
    stubOfetch([{ match: '/v1beta/batches/xyz', data: { state: 'RUNNING' } }])
    const { pollGeminiBatch } = await import('./gemini-batch')

    await expect(pollGeminiBatch('batches/xyz', config)).resolves.toEqual({ state: 'pending' })
  })

  it('recognizes the current top-level dest.fileName result path', async () => {
    stubOfetch([
      {
        match: '/v1beta/batches/xyz',
        data: { state: 'JOB_STATE_SUCCEEDED', dest: { fileName: 'files/results' } },
      },
    ])
    const { pollGeminiBatch } = await import('./gemini-batch')

    await expect(pollGeminiBatch('batches/xyz', config)).resolves.toEqual({
      state: 'succeeded',
      resultFileName: 'files/results',
    })
  })

  it('reports failed for a failed/cancelled state', async () => {
    stubOfetch([{ match: '/v1beta/batches/xyz', data: { metadata: { state: 'JOB_STATE_FAILED' } } }])
    const { pollGeminiBatch } = await import('./gemini-batch')

    await expect(pollGeminiBatch('batches/xyz', config)).resolves.toEqual({ state: 'failed' })
  })

  it('reports expired for an expired state', async () => {
    stubOfetch([{ match: '/v1beta/batches/xyz', data: { metadata: { state: 'JOB_STATE_EXPIRED' } } }])
    const { pollGeminiBatch } = await import('./gemini-batch')

    await expect(pollGeminiBatch('batches/xyz', config)).resolves.toEqual({ state: 'expired' })
  })

  it('treats success without a discoverable result file name as failed', async () => {
    stubOfetch([{ match: '/v1beta/batches/xyz', data: { metadata: { state: 'JOB_STATE_SUCCEEDED' } } }])
    const { pollGeminiBatch } = await import('./gemini-batch')

    await expect(pollGeminiBatch('batches/xyz', config)).resolves.toEqual({ state: 'failed' })
  })

  it('treats an unrecognized state as pending rather than throwing', async () => {
    stubOfetch([{ match: '/v1beta/batches/xyz', data: { metadata: { state: 'SOMETHING_NEW' } } }])
    const { pollGeminiBatch } = await import('./gemini-batch')

    await expect(pollGeminiBatch('batches/xyz', config)).resolves.toEqual({ state: 'pending' })
  })

  it('treats a request failure as pending (retried next tick)', async () => {
    stubOfetch([{ match: '/v1beta/batches/xyz', error: new Error('timeout') }])
    const { pollGeminiBatch } = await import('./gemini-batch')

    await expect(pollGeminiBatch('batches/xyz', config)).resolves.toEqual({ state: 'pending' })
  })
})

describe('isLlmBatchPending', () => {
  it('is false when no llmBatchJob marker is set', async () => {
    const { isLlmBatchPending } = await import('./llm-batch')
    expect(isLlmBatchPending(undefined)).toBe(false)
    expect(isLlmBatchPending({ at: '2026-07-23T00:00:00.000Z' })).toBe(false)
  })

  it('is true for a marker younger than 48h', async () => {
    const { isLlmBatchPending } = await import('./llm-batch')
    const at = new Date('2026-07-23T00:00:00.000Z')
    const now = at.getTime() + 60 * 60 * 1000
    expect(isLlmBatchPending({ llmBatchJob: 'batches/x', at: at.toISOString() }, now)).toBe(true)
  })

  it('is false (orphaned) for a marker older than 48h', async () => {
    const { isLlmBatchPending } = await import('./llm-batch')
    const at = new Date('2026-07-23T00:00:00.000Z')
    const now = at.getTime() + 49 * 60 * 60 * 1000
    expect(isLlmBatchPending({ llmBatchJob: 'batches/x', at: at.toISOString() }, now)).toBe(false)
  })
})

describe('fetchGeminiBatchResults', () => {
  it('parses successful and errored result lines', async () => {
    const lines = [
      JSON.stringify({
        key: 'zvg-portal:1',
        response: { candidates: [{ content: { parts: [{ text: '{"propertyType":"einfamilienhaus","landAreaSqm":500}' }] } }] },
      }),
      JSON.stringify({ key: 'zvg-portal:2', error: { message: 'internal error' } }),
    ]
    stubOfetch([{ match: '/download/v1beta/files/results', data: lines.join('\n') }])
    const { fetchGeminiBatchResults } = await import('./gemini-batch')

    const results = await fetchGeminiBatchResults('files/results', config)

    expect(results).toHaveLength(2)
    expect(results[0]!.key).toBe('zvg-portal:1')
    expect(results[0]!.extraction?.propertyType).toBe('einfamilienhaus')
    expect(results[0]!.extraction?.landAreaSqm).toBe(500)
    expect(results[1]).toEqual({ key: 'zvg-portal:2', extraction: null })
  })

  it('skips malformed lines instead of throwing', async () => {
    const lines = ['not json', JSON.stringify({ key: 'zvg-portal:1', response: {} })]
    stubOfetch([{ match: '/download/v1beta/files/results', data: lines.join('\n') }])
    const { fetchGeminiBatchResults } = await import('./gemini-batch')

    const results = await fetchGeminiBatchResults('files/results', config)

    expect(results).toEqual([{ key: 'zvg-portal:1', extraction: null }])
  })

  it('falls back to metadata.key and input-order customIdMap for result lines', async () => {
    const lines = [
      JSON.stringify({
        metadata: { key: 'zvg-portal:1' },
        response: { candidates: [{ content: { parts: [{ text: '{"propertyType":"einfamilienhaus"}' }] } }] },
      }),
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"landAreaSqm":600}' }] } }],
      }),
    ]
    stubOfetch([{ match: '/download/v1beta/files/results', data: lines.join('\n') }])
    const { fetchGeminiBatchResults } = await import('./gemini-batch')

    const results = await fetchGeminiBatchResults('files/results', config, { '1': 'zvg-portal:2' })

    expect(results[0]?.key).toBe('zvg-portal:1')
    expect(results[1]).toEqual({
      key: 'zvg-portal:2',
      extraction: expect.objectContaining({ landAreaSqm: 600 }),
    })
  })

  it('returns an empty array when the download request fails', async () => {
    stubOfetch([{ match: '/download/v1beta/files/results', error: new Error('gone') }])
    const { fetchGeminiBatchResults } = await import('./gemini-batch')

    await expect(fetchGeminiBatchResults('files/results', config)).resolves.toEqual([])
  })
})
