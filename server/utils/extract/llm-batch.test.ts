import { describe, expect, it } from 'vitest'
import { supportsLlmBatch, supportsNativeBatchDocuments } from './llm-batch'

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
