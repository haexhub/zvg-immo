import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmConfig } from './llm'
import { callSummaryLlm, callTranslationLlm } from './text-llm'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('callSummaryLlm', () => {
  const openAiConfig: LlmConfig = { provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt' }
  const geminiConfig: LlmConfig = {
    provider: 'gemini-native',
    baseUrl: 'https://gemini.example',
    apiKey: 'k',
    model: 'gemini-flash-latest',
  }

  it('extracts the summary field via the openai-compatible provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ summary: '**Objekt** Hallo' }) } }],
    })
    vi.stubGlobal('$fetch', fetchMock)
    await expect(callSummaryLlm('sys', 'user text', openAiConfig)).resolves.toBe('**Objekt** Hallo')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  // Regression test for the bug this file fixes: summary/translation used to
  // hardcode Anthropic's /v1/messages format regardless of which provider
  // runtimeConfig.extractLlm actually selected, so a Gemini-configured
  // deployment 404'd. This confirms the wire format now follows the config.
  it('extracts the summary field via the gemini-native provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'Zusammenfassung' }) }] } }],
    })
    vi.stubGlobal('$fetch', fetchMock)
    await expect(callSummaryLlm('sys', 'user text', geminiConfig)).resolves.toBe('Zusammenfassung')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gemini.example/v1beta/models/gemini-flash-latest:generateContent',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('returns null when the provider response has no summary field', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ choices: [{ message: { content: '{}' } }] }))
    await expect(callSummaryLlm('sys', 'user text', openAiConfig)).resolves.toBeNull()
  })

  it('returns null on request failure', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('boom')))
    await expect(callSummaryLlm('sys', 'user text', openAiConfig)).resolves.toBeNull()
  })
})

describe('callTranslationLlm', () => {
  const config: LlmConfig = { provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt' }

  function stubResponse(payload: Record<string, unknown>) {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(payload) } }] }))
  }

  it('returns the translated title and description', async () => {
    stubResponse({ title: 'Haus', description: 'Schöne Beschreibung' })
    await expect(callTranslationLlm('sys', 'user text', 'House', 'Nice description', config)).resolves.toEqual({
      title: 'Haus',
      description: 'Schöne Beschreibung',
    })
  })

  it('keeps a null field null when the source was null', async () => {
    stubResponse({ title: 'Haus', description: null })
    await expect(callTranslationLlm('sys', 'user text', 'House', null, config)).resolves.toEqual({
      title: 'Haus',
      description: null,
    })
  })

  it('signals failure when the source had a title but the model returned an empty one', async () => {
    stubResponse({ title: '', description: 'x' })
    await expect(callTranslationLlm('sys', 'user text', 'House', 'x', config)).resolves.toBeNull()
  })

  it('returns null on request failure', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('boom')))
    await expect(callTranslationLlm('sys', 'user text', 'House', 'desc', config)).resolves.toBeNull()
  })
})
