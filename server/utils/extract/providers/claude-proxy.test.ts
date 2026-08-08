import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionRequest } from '../llm'
import { ClaudeProxyProvider } from './claude-proxy'

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

  it('calls onRequestError once retries are exhausted for a non-429 failure, but not for a 429 (which rethrows instead)', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(error(500)))
    const provider = new ClaudeProxyProvider(config)
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
})
