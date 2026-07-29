import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionRequest } from '../llm'
import { OpenAiCompatibleProvider, parseOpenAiExtractionResponse, toOpenAiContent } from './openai-compatible'

describe('toOpenAiContent', () => {
  it('translates text and image parts, dropping document parts', () => {
    expect(
      toOpenAiContent([
        { type: 'text', text: 'hallo' },
        { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
        { type: 'document', mimeType: 'application/pdf', data: 'BBBB' },
      ]),
    ).toEqual([
      { type: 'text', text: 'hallo' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ])
  })

  it('returns an empty array for no parts', () => {
    expect(toOpenAiContent([])).toEqual([])
  })
})

describe('parseOpenAiExtractionResponse', () => {
  it('parses the JSON string from the first choice message content', () => {
    const resp = { choices: [{ message: { content: '{"propertyType":"haus","landAreaSqm":620}' } }] }
    expect(parseOpenAiExtractionResponse(resp)).toEqual({ propertyType: 'haus', landAreaSqm: 620 })
  })

  it('returns null for malformed responses', () => {
    expect(parseOpenAiExtractionResponse(null)).toBeNull()
    expect(parseOpenAiExtractionResponse({})).toBeNull()
    expect(parseOpenAiExtractionResponse({ choices: [] })).toBeNull()
    expect(parseOpenAiExtractionResponse({ choices: [{ message: { content: 'not json' } }] })).toBeNull()
    expect(parseOpenAiExtractionResponse({ choices: [{ message: { content: '"just a string"' } }] })).toBeNull()
  })
})

describe('OpenAiCompatibleProvider.extract', () => {
  const config = { baseUrl: 'https://openai.example', apiKey: 'k', model: 'gpt' }
  const req: ExtractionRequest = { systemPrompt: 'p', schema: {}, parts: [{ type: 'text', text: 'hi' }] }

  function error(status: number) {
    return Object.assign(new Error(`http ${status}`), { response: { status } })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rethrows a 429 instead of returning null, so it is not counted toward the retry-lockout', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(error(429)))
    const provider = new OpenAiCompatibleProvider(config)
    await expect(provider.extract(req)).rejects.toThrow('http 429')
  })

  it('surfaces a non-429 request failure', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(error(500)))
    const provider = new OpenAiCompatibleProvider(config)
    await expect(provider.extract(req)).rejects.toMatchObject({ name: 'LlmProviderError' })
  })
})
