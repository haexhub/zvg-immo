import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionRequest } from '../llm'
import { ClaudeProxyProvider, parseClaudeUsage } from './claude-proxy'

describe('parseClaudeUsage', () => {
  it('reads input/output tokens', () => {
    expect(parseClaudeUsage({ usage: { input_tokens: 200, output_tokens: 60 } })).toEqual({
      inputTokens: 200,
      outputTokens: 60,
    })
  })

  it('returns nulls when usage is missing', () => {
    expect(parseClaudeUsage({})).toEqual({ inputTokens: null, outputTokens: null })
  })
})

describe('ClaudeProxyProvider.extract', () => {
  const config = { baseUrl: 'https://proxy.example', apiKey: 'k', model: 'claude-haiku-4-5' }
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
    const provider = new ClaudeProxyProvider(config)
    const promise = provider.extract(req)
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toThrow('http 429')
  })

  it('retries a transient (non-429) failure and returns the result once it succeeds', async () => {
    const okResponse = { content: [{ type: 'tool_use', name: 'final_result', input: { propertyType: 'haus' } }] }
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(error(500))
      .mockRejectedValueOnce(error(500))
      .mockResolvedValueOnce(okResponse)
    vi.stubGlobal('$fetch', fetchMock)
    const provider = new ClaudeProxyProvider(config)
    const promise = provider.extract(req)
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ propertyType: 'haus' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('surfaces a non-429 request failure once retries are exhausted', async () => {
    const fetchMock = vi.fn().mockRejectedValue(error(500))
    vi.stubGlobal('$fetch', fetchMock)
    const provider = new ClaudeProxyProvider(config)
    const promise = provider.extract(req)
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toMatchObject({ name: 'LlmProviderError' })
    expect(fetchMock).toHaveBeenCalledTimes(3) // 1 initial attempt + 2 retries
  })

  it('does not retry a non-transient (e.g. 401/400) failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(error(401))
    vi.stubGlobal('$fetch', fetchMock)
    const provider = new ClaudeProxyProvider(config)
    const promise = provider.extract(req)
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toMatchObject({ name: 'LlmProviderError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports and rejects the first request failure when reprocess supplies onRequestError, avoiding costly duplicate prompts', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(error(500)))
    const provider = new ClaudeProxyProvider(config)
    const onRequestError = vi.fn()
    const promise = provider.extract(req, { onRequestError })
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toMatchObject({ name: 'LlmProviderError' })
    expect(onRequestError).toHaveBeenCalledTimes(1)
    expect(vi.mocked($fetch)).toHaveBeenCalledTimes(1)

    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(error(429)))
    const rateLimitedOnRequestError = vi.fn()
    const rateLimitedPromise = provider.extract(req, { onRequestError: rateLimitedOnRequestError })
    rateLimitedPromise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(rateLimitedPromise).rejects.toThrow('http 429')
    expect(rateLimitedOnRequestError).not.toHaveBeenCalled()
  })

  describe('reprocess (onRequestError) and a restarting proxy', () => {
    const okResponse = { content: [{ type: 'tool_use', name: 'final_result', input: { propertyType: 'haus' } }] }
    const dropped = () => Object.assign(new TypeError('[POST] "http://proxy:8080/v1/messages": <no response> fetch failed'), { cause: { code: 'ECONNREFUSED' } })

    it('waits out a dropped connection and re-sends instead of reporting the provider as down', async () => {
      const fetchMock = vi.fn().mockRejectedValueOnce(dropped()).mockRejectedValueOnce(dropped()).mockResolvedValue(okResponse)
      vi.stubGlobal('$fetch', fetchMock)
      const onRequestError = vi.fn()
      const promise = new ClaudeProxyProvider(config).extract(req, { onRequestError })
      await vi.runAllTimersAsync()
      await expect(promise).resolves.toEqual({ propertyType: 'haus' })
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(onRequestError).not.toHaveBeenCalled()
    })

    it('still gives up (and reports it) once the proxy stays unreachable', async () => {
      const fetchMock = vi.fn().mockImplementation(() => Promise.reject(dropped()))
      vi.stubGlobal('$fetch', fetchMock)
      const onRequestError = vi.fn()
      const promise = new ClaudeProxyProvider(config).extract(req, { onRequestError })
      promise.catch(() => {})
      await vi.runAllTimersAsync()
      await expect(promise).rejects.toMatchObject({ name: 'LlmProviderError' })
      expect(fetchMock).toHaveBeenCalledTimes(4)
      expect(onRequestError).toHaveBeenCalledTimes(1)
    })

    it('does not re-send after a client timeout, which may still be running on the proxy', async () => {
      const timeout = Object.assign(new Error('[POST] "x": <no response> The operation was aborted due to timeout'), { cause: { name: 'TimeoutError' } })
      const fetchMock = vi.fn().mockRejectedValue(timeout)
      vi.stubGlobal('$fetch', fetchMock)
      const promise = new ClaudeProxyProvider(config).extract(req, { onRequestError: vi.fn() })
      promise.catch(() => {})
      await vi.runAllTimersAsync()
      await expect(promise).rejects.toMatchObject({ name: 'LlmProviderError' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  it('resolves a truncated response to null when reprocess supplies onRequestError', async () => {
    const truncated = { content: [{ type: 'tool_use', input: null }], stop_reason: 'max_tokens' }
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(truncated))
    const provider = new ClaudeProxyProvider(config)
    await expect(provider.extract(req, { onRequestError: vi.fn() })).resolves.toBeNull()
    await expect(provider.extract(req)).rejects.toThrow('ungültige oder leere Provider-Antwort')
  })

  it('calls onUsage with the token counts once a response is received', async () => {
    const okResponse = {
      content: [{ type: 'tool_use', name: 'final_result', input: { propertyType: 'haus' } }],
      usage: { input_tokens: 200, output_tokens: 60 },
    }
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(okResponse))
    const provider = new ClaudeProxyProvider(config)
    const onUsage = vi.fn()
    await provider.extract(req, { onUsage })
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 200, outputTokens: 60 })
  })

  it('never calls onUsage on a request failure (no response to read usage off)', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(error(401)))
    const provider = new ClaudeProxyProvider(config)
    const onUsage = vi.fn()
    await provider.extract(req, { onUsage }).catch(() => {})
    expect(onUsage).not.toHaveBeenCalled()
  })
})
