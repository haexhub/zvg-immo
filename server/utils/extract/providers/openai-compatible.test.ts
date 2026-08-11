import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionRequest } from '../llm'
import { OpenAiCompatibleProvider, parseOpenAiExtractionResponse, parseOpenAiUsage, toOpenAiContent } from './openai-compatible'

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

describe('parseOpenAiUsage', () => {
  it('reads prompt/completion tokens', () => {
    expect(parseOpenAiUsage({ usage: { prompt_tokens: 120, completion_tokens: 45 } })).toEqual({
      inputTokens: 120,
      outputTokens: 45,
    })
  })

  it('returns nulls when usage is missing', () => {
    expect(parseOpenAiUsage({})).toEqual({ inputTokens: null, outputTokens: null })
  })

  it('reads the OpenRouter-reported cost when present', () => {
    expect(parseOpenAiUsage({ usage: { prompt_tokens: 120, completion_tokens: 45, cost: 0.0042 } })).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      costUsd: 0.0042,
    })
  })
})

describe('OpenAiCompatibleProvider.extract', () => {
  const config = { baseUrl: 'https://openai.example', apiKey: 'k', model: 'gpt' }
  const req: ExtractionRequest = { systemPrompt: 'p', schema: {}, parts: [{ type: 'text', text: 'hi' }] }

  function error(status: number) {
    return Object.assign(new Error(`http ${status}`), { response: { status } })
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('rethrows a 429 instead of returning null, so it is not counted toward the retry-lockout', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(error(429)))
    const provider = new OpenAiCompatibleProvider(config)
    const promise = provider.extract(req)
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toThrow('http 429')
  })

  it('retries a transient (non-429) failure and returns the result once it succeeds', async () => {
    const okResponse = { choices: [{ message: { content: '{"propertyType":"haus"}' } }] }
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(error(500))
      .mockRejectedValueOnce(error(500))
      .mockResolvedValueOnce(okResponse)
    vi.stubGlobal('$fetch', fetchMock)
    const provider = new OpenAiCompatibleProvider(config)
    const promise = provider.extract(req)
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ propertyType: 'haus' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('surfaces a non-429 request failure once retries are exhausted', async () => {
    const fetchMock = vi.fn().mockRejectedValue(error(500))
    vi.stubGlobal('$fetch', fetchMock)
    const provider = new OpenAiCompatibleProvider(config)
    const promise = provider.extract(req)
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toMatchObject({ name: 'LlmProviderError' })
    expect(fetchMock).toHaveBeenCalledTimes(3) // 1 initial attempt + 2 retries
  })

  it('does not retry a non-transient (e.g. 401/400) failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(error(401))
    vi.stubGlobal('$fetch', fetchMock)
    const provider = new OpenAiCompatibleProvider(config)
    const promise = provider.extract(req)
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toMatchObject({ name: 'LlmProviderError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('appends the provider-supplied error detail (e.g. OpenRouter\'s moderation reason) to the thrown message', async () => {
    const err = Object.assign(new Error('http 403'), {
      response: { status: 403 },
      data: { error: { message: 'Your input was flagged by moderation.' } },
    })
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(err))
    const provider = new OpenAiCompatibleProvider(config)
    const promise = provider.extract(req)
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toThrow('http 403 — Your input was flagged by moderation.')
  })

  it('calls onRequestError once retries are exhausted for a non-429 failure, but not for a 429 (which rethrows instead)', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(error(500)))
    const provider = new OpenAiCompatibleProvider(config)
    const onRequestError = vi.fn()
    const promise = provider.extract(req, { onRequestError })
    await vi.runAllTimersAsync()
    await promise
    expect(onRequestError).toHaveBeenCalledTimes(1)

    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(error(429)))
    const rateLimitedOnRequestError = vi.fn()
    const rateLimitedPromise = provider.extract(req, { onRequestError: rateLimitedOnRequestError })
    rateLimitedPromise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(rateLimitedPromise).rejects.toThrow('http 429')
    expect(rateLimitedOnRequestError).not.toHaveBeenCalled()
  })

  it('strips the OpenRouter batch-pricing ":batch" suffix from the synchronous request model', async () => {
    const okResponse = { choices: [{ message: { content: '{}' } }] }
    const fetchMock = vi.fn().mockResolvedValue(okResponse)
    vi.stubGlobal('$fetch', fetchMock)
    const provider = new OpenAiCompatibleProvider({
      ...config,
      provider: 'openrouter',
      model: 'google/gemini-3.5-flash-lite:batch',
    })
    await provider.extract(req)
    expect(fetchMock.mock.calls[0]![1].body.model).toBe('google/gemini-3.5-flash-lite')
  })

  it('leaves a non-OpenRouter model untouched even if it happens to end in ":batch"', async () => {
    const okResponse = { choices: [{ message: { content: '{}' } }] }
    const fetchMock = vi.fn().mockResolvedValue(okResponse)
    vi.stubGlobal('$fetch', fetchMock)
    const provider = new OpenAiCompatibleProvider({ ...config, model: 'gpt:batch' })
    await provider.extract(req)
    expect(fetchMock.mock.calls[0]![1].body.model).toBe('gpt:batch')
  })

  it('opts into OpenRouter usage accounting so the response reports billed cost', async () => {
    const okResponse = { choices: [{ message: { content: '{}' } }] }
    const fetchMock = vi.fn().mockResolvedValue(okResponse)
    vi.stubGlobal('$fetch', fetchMock)
    const provider = new OpenAiCompatibleProvider({ ...config, provider: 'openrouter', model: 'google/gemini-3.5-flash-lite' })
    await provider.extract(req)
    expect(fetchMock.mock.calls[0]![1].body.usage).toEqual({ include: true })
  })

  it('does not send the OpenRouter usage-accounting flag to another provider', async () => {
    const okResponse = { choices: [{ message: { content: '{}' } }] }
    const fetchMock = vi.fn().mockResolvedValue(okResponse)
    vi.stubGlobal('$fetch', fetchMock)
    const provider = new OpenAiCompatibleProvider(config)
    await provider.extract(req)
    expect(fetchMock.mock.calls[0]![1].body.usage).toBeUndefined()
  })

  it('calls onUsage with the token counts once a response is received, even if unparseable', async () => {
    const okResponse = { choices: [{ message: { content: '{"propertyType":"haus"}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(okResponse))
    const provider = new OpenAiCompatibleProvider(config)
    const onUsage = vi.fn()
    await provider.extract(req, { onUsage })
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 3 })

    const unparseable = { choices: [{ message: { content: 'not json' } }], usage: { prompt_tokens: 5, completion_tokens: 0 } }
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(unparseable))
    const onUsageForFailedParse = vi.fn()
    await provider.extract(req, { onUsage: onUsageForFailedParse }).catch(() => {})
    expect(onUsageForFailedParse).toHaveBeenCalledWith({ inputTokens: 5, outputTokens: 0 })
  })

  it('never calls onUsage on a request failure (no response to read usage off)', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(error(401)))
    const provider = new OpenAiCompatibleProvider(config)
    const onUsage = vi.fn()
    await provider.extract(req, { onUsage }).catch(() => {})
    expect(onUsage).not.toHaveBeenCalled()
  })
})
