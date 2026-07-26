import { describe, expect, it } from 'vitest'
import { supportsLlmBatch, supportsNativeBatchDocuments } from './llm-batch'

describe('llm-batch provider gates', () => {
  it('supports Gemini natively and Anthropic only through an authenticated proxy token', () => {
    expect(supportsLlmBatch({ provider: 'gemini-native', baseUrl: 'http://gemini', model: 'gemini-flash-latest' }))
      .toBe(true)
    expect(supportsLlmBatch({ provider: 'claude-proxy', baseUrl: 'http://proxy', apiKey: 'proxy-token', model: 'claude-haiku-4-5' }))
      .toBe(true)
    expect(supportsLlmBatch({ provider: 'claude-proxy', baseUrl: 'http://proxy', model: 'claude-haiku-4-5' }))
      .toBe(false)
    expect(supportsLlmBatch({ provider: 'openai-compatible', baseUrl: 'http://api', model: 'gpt' }))
      .toBe(false)
  })

  it('reports which batch-capable providers can submit native documents', () => {
    expect(supportsNativeBatchDocuments({ provider: 'gemini-native', baseUrl: 'http://gemini', model: 'gemini-flash-latest' }))
      .toBe(true)
    expect(supportsNativeBatchDocuments({ provider: 'claude-proxy', baseUrl: 'http://proxy', apiKey: 'proxy-token', model: 'claude-haiku-4-5' }))
      .toBe(true)
    expect(supportsNativeBatchDocuments({ provider: 'claude-proxy', baseUrl: 'http://proxy', model: 'claude-haiku-4-5' }))
      .toBe(false)
  })
})
