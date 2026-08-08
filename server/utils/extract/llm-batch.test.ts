import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  batchSupportsMultimodal,
  fetchLlmBatchResults,
  isLlmBatchProviderBroken,
  pollLlmBatch,
  supportsLlmBatch,
  supportsNativeBatchDocuments,
} from './llm-batch'

vi.mock('../llm-batch-jobs', () => ({ getLlmBatchCapability: vi.fn(), insertLlmBatchJob: vi.fn(), recordLlmBatchCapability: vi.fn() }))

describe('llm-batch provider gates', () => {
  beforeEach(() => {
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { geminiBatchTier: 'paid' } }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('gates Gemini on the configured batch tier — free tier cannot use Google\'s Batch API at all', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { geminiBatchTier: 'free' } }))
    expect(supportsLlmBatch({ provider: 'gemini-native', baseUrl: 'http://gemini', model: 'gemini-flash-latest' }))
      .toBe(false)
    vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: { geminiBatchTier: 'paid' } }))
    expect(supportsLlmBatch({ provider: 'gemini-native', baseUrl: 'http://gemini', model: 'gemini-flash-latest' }))
      .toBe(true)
  })

  it('supports OpenAI with an API key, and Anthropic only through an authenticated proxy token', () => {
    expect(supportsLlmBatch({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-test' }))
      .toBe(true)
    expect(supportsLlmBatch({ provider: 'openai-compatible', baseUrl: 'https://api.moonshot.ai/v1', apiKey: 'sk-test', model: 'kimi' }))
      .toBe(false)
    expect(supportsLlmBatch({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com', apiKey: 'sk-test', model: 'gpt-test' }))
      .toBe(false)
    expect(supportsLlmBatch({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test' }))
      .toBe(false)
    expect(supportsLlmBatch({ provider: 'claude-proxy', baseUrl: 'http://proxy', apiKey: 'proxy-token', model: 'claude-haiku-4-5' }))
      .toBe(true)
    expect(supportsLlmBatch({ provider: 'claude-proxy', baseUrl: 'http://proxy', model: 'claude-haiku-4-5' }))
      .toBe(false)
  })

  it('supports OpenRouter with an API key', () => {
    expect(supportsLlmBatch({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test', model: 'google/gemini-3.5-flash-lite' }))
      .toBe(true)
    expect(supportsLlmBatch({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-3.5-flash-lite' }))
      .toBe(false)
  })

  it('batchSupportsMultimodal is an explicit allowlist, not an OpenRouter exclusion — an unrecognized provider defaults to false', () => {
    expect(batchSupportsMultimodal({ provider: 'gemini-native', baseUrl: 'http://gemini', model: 'x' })).toBe(true)
    expect(batchSupportsMultimodal({ provider: 'claude-proxy', baseUrl: 'http://proxy', model: 'x' })).toBe(true)
    expect(batchSupportsMultimodal({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'x' })).toBe(true)
    expect(batchSupportsMultimodal({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'x' })).toBe(false)
    expect(batchSupportsMultimodal({ baseUrl: 'https://future-provider.example', model: 'x' })).toBe(false)
    expect(batchSupportsMultimodal(null)).toBe(false)
  })

  it('isLlmBatchProviderBroken reflects the last recorded real submit attempt for that provider', async () => {
    const { getLlmBatchCapability } = await import('../llm-batch-jobs')
    const config = { provider: 'gemini-native' as const, baseUrl: 'http://gemini', model: 'gemini-flash-latest' }

    vi.mocked(getLlmBatchCapability).mockResolvedValue(null)
    await expect(isLlmBatchProviderBroken(config)).resolves.toBe(false)

    vi.mocked(getLlmBatchCapability).mockResolvedValue({
      ok: false,
      message: 'FAILED_PRECONDITION: Precondition check failed.',
      checkedAt: '2026-07-27T14:30:00.000Z',
      source: 'enrich',
    })
    await expect(isLlmBatchProviderBroken(config)).resolves.toBe(true)
    expect(getLlmBatchCapability).toHaveBeenCalledWith('gemini-native')

    vi.mocked(getLlmBatchCapability).mockResolvedValue({
      ok: true,
      message: null,
      checkedAt: '2026-07-27T15:00:00.000Z',
      source: 'enrich',
    })
    await expect(isLlmBatchProviderBroken(config)).resolves.toBe(false)

    await expect(isLlmBatchProviderBroken(null)).resolves.toBe(false)
    await expect(isLlmBatchProviderBroken({ baseUrl: 'x', model: 'y' })).resolves.toBe(false)
  })

  it('reports which batch-capable providers can submit native documents', () => {
    expect(supportsNativeBatchDocuments({ provider: 'gemini-native', baseUrl: 'http://gemini', model: 'gemini-flash-latest' }))
      .toBe(true)
    expect(supportsNativeBatchDocuments({ provider: 'claude-proxy', baseUrl: 'http://proxy', apiKey: 'proxy-token', model: 'claude-haiku-4-5' }))
      .toBe(true)
    expect(supportsNativeBatchDocuments({ provider: 'claude-proxy', baseUrl: 'http://proxy', model: 'claude-haiku-4-5' }))
      .toBe(false)
    expect(supportsNativeBatchDocuments({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-test' }))
      .toBe(false)
  })
})

describe('llm-batch dispatch avoids the OpenRouter/OpenAI jobName prefix collision', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes an "openrouter_"-wrapped jobName to the OpenRouter beta endpoint, not the OpenAI one', async () => {
    const fetchFn = vi.fn(async () => ({ status: 'completed' })) as unknown as typeof $fetch
    vi.stubGlobal('$fetch', fetchFn)
    const config = { provider: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test', model: 'x' }

    await expect(pollLlmBatch('openrouter_batch_x', config)).resolves.toEqual({ state: 'succeeded' })
    expect(fetchFn).toHaveBeenCalledWith('https://openrouter.ai/api/beta/batches/batch_x', expect.anything())
  })

  it('still routes a bare "batch_"-prefixed jobName to OpenAI', async () => {
    const fetchFn = vi.fn(async () => ({ status: 'completed', output_file_id: 'file-out' })) as unknown as typeof $fetch
    vi.stubGlobal('$fetch', fetchFn)
    const config = { provider: 'openai-compatible' as const, baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'x' }

    await expect(pollLlmBatch('batch_x', config)).resolves.toEqual({ state: 'succeeded', resultFileName: 'file-out' })
    expect(fetchFn).toHaveBeenCalledWith('https://api.openai.com/v1/batches/batch_x', expect.anything())
  })

  it('fetchLlmBatchResults dispatches an "openrouter_"-wrapped jobName without requiring a resultFileName', async () => {
    const fetchFn = vi.fn(async () => ({ results: [] })) as unknown as typeof $fetch
    vi.stubGlobal('$fetch', fetchFn)
    const config = { provider: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test', model: 'x' }

    await expect(fetchLlmBatchResults('openrouter_batch_x', undefined, config, {})).resolves.toEqual([])
    expect(fetchFn).toHaveBeenCalledWith('https://openrouter.ai/api/beta/batches/batch_x', expect.anything())
  })
})
