import { describe, expect, it } from 'vitest'
import { llmProviderRequiresApiKey, supportsLlmProviderExecutionMode } from './llm-provider-capabilities'

describe('llmProviderRequiresApiKey', () => {
  it('always requires a key for gemini-native, whose endpoint is Google-hosted', () => {
    expect(llmProviderRequiresApiKey('gemini-native', 'https://generativelanguage.googleapis.com')).toBe(true)
  })

  it('requires a key for a public openai-compatible endpoint', () => {
    expect(llmProviderRequiresApiKey('openai-compatible', 'https://api.openai.com/v1')).toBe(true)
  })

  it.each([
    ['container hostname without a dot', 'http://haex-claude-proxy:8080'],
    ['localhost', 'http://localhost:8080'],
    ['loopback', 'http://127.0.0.1:8080'],
    ['private 10/8', 'http://10.1.2.3:8080'],
    ['private 192.168/16', 'http://192.168.1.10:8080'],
    ['private 172.16/12', 'http://172.20.0.5:8080'],
    ['IPv6 loopback', 'http://[::1]:8080'],
  ])('exempts an internal endpoint (%s), which legitimately runs keyless', (_label, baseUrl) => {
    expect(llmProviderRequiresApiKey('claude-proxy', baseUrl)).toBe(false)
  })

  it.each([
    ['IPv6 unique-local fd00::/8', 'http://[fd12:3456::1]:8080'],
    ['IPv6 link-local fe80::/10', 'http://[fe80::1]:8080'],
  ])('exempts a private IPv6 range (%s)', (_label, baseUrl) => {
    expect(llmProviderRequiresApiKey('claude-proxy', baseUrl)).toBe(false)
  })

  it('requires a key for a globally routable IPv6 literal, which carries no dot either', () => {
    expect(llmProviderRequiresApiKey('openai-compatible', 'http://[2001:4860:4860::8888]:8080')).toBe(true)
  })

  it('treats 172.32/12 as public — just outside the private range', () => {
    expect(llmProviderRequiresApiKey('openai-compatible', 'http://172.32.0.1:8080')).toBe(true)
  })

  it('does not require a key when the baseUrl is unparseable', () => {
    expect(llmProviderRequiresApiKey('openai-compatible', 'not a url')).toBe(false)
  })
})

describe('supportsLlmProviderExecutionMode', () => {
  it('allows sync for every provider regardless of key/baseUrl', () => {
    expect(supportsLlmProviderExecutionMode('openrouter', 'sync')).toBe(true)
    expect(supportsLlmProviderExecutionMode('openai-compatible', 'sync')).toBe(true)
  })

  it('gates OpenRouter batch on having an API key, same as the Claude proxy', () => {
    expect(supportsLlmProviderExecutionMode('openrouter', 'batch', 'sk-or-test', 'https://openrouter.ai/api/v1')).toBe(true)
    expect(supportsLlmProviderExecutionMode('openrouter', 'batch', '', 'https://openrouter.ai/api/v1')).toBe(false)
    expect(supportsLlmProviderExecutionMode('claude-proxy', 'batch', 'proxy-token', 'http://proxy')).toBe(true)
    expect(supportsLlmProviderExecutionMode('claude-proxy', 'batch', '', 'http://proxy')).toBe(false)
  })

  it('gemini-native always supports batch, openai-compatible only on api.openai.com/v1 with a key', () => {
    expect(supportsLlmProviderExecutionMode('gemini-native', 'batch')).toBe(true)
    expect(supportsLlmProviderExecutionMode('openai-compatible', 'batch', 'sk-test', 'https://api.openai.com/v1')).toBe(true)
    expect(supportsLlmProviderExecutionMode('openai-compatible', 'batch', 'sk-test', 'https://api.moonshot.ai/v1')).toBe(false)
  })
})
