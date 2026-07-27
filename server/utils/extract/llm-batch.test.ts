import { describe, expect, it, vi } from 'vitest'
import { isLlmBatchProviderBroken, supportsLlmBatch, supportsNativeBatchDocuments } from './llm-batch'

vi.mock('../llm-batch-jobs', () => ({ getLlmBatchCapability: vi.fn() }))

describe('llm-batch provider gates', () => {
  it('supports Gemini natively, OpenAI with an API key, and Anthropic only through an authenticated proxy token', () => {
    expect(supportsLlmBatch({ provider: 'gemini-native', baseUrl: 'http://gemini', model: 'gemini-flash-latest' }))
      .toBe(true)
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
