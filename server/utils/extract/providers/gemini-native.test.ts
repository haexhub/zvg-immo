import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionRequest } from '../llm'
import { isGeminiDailyQuotaError, parseGeminiExtractionResponse, toGeminiParts } from './gemini-native'

describe('toGeminiParts', () => {
  it('translates text, image and document parts to Gemini parts', () => {
    expect(
      toGeminiParts([
        { type: 'text', text: 'hallo' },
        { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
        { type: 'document', mimeType: 'application/pdf', data: 'BBBB' },
      ]),
    ).toEqual([
      { text: 'hallo' },
      { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
      { inlineData: { mimeType: 'application/pdf', data: 'BBBB' } },
    ])
  })

  it('returns an empty array for no parts', () => {
    expect(toGeminiParts([])).toEqual([])
  })
})

describe('parseGeminiExtractionResponse', () => {
  it('parses the JSON string from the first candidate part', () => {
    const resp = {
      candidates: [{ content: { parts: [{ text: '{"propertyType":"haus","landAreaSqm":620}' }] } }],
    }
    expect(parseGeminiExtractionResponse(resp)).toEqual({ propertyType: 'haus', landAreaSqm: 620 })
  })

  it('returns null for malformed responses', () => {
    expect(parseGeminiExtractionResponse(null)).toBeNull()
    expect(parseGeminiExtractionResponse({})).toBeNull()
    expect(parseGeminiExtractionResponse({ candidates: [] })).toBeNull()
    expect(parseGeminiExtractionResponse({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] })).toBeNull()
  })
})

describe('GeminiNativeProvider.extract — 429 pacing/retry', () => {
  const config = { baseUrl: 'https://gemini.example', apiKey: 'k', model: 'gemini-flash-latest' }
  const req: ExtractionRequest = { systemPrompt: 'p', schema: {}, parts: [{ type: 'text', text: 'hi' }] }
  const okResponse = { candidates: [{ content: { parts: [{ text: '{"propertyType":"haus"}' }] } }] }

  // Each test re-imports the module fresh so the module-level pacing queue/
  // lastRequestAt (shared across all concurrent callers by design, see
  // gemini-native.ts) doesn't leak state between tests.
  async function freshProvider() {
    vi.resetModules()
    const mod = await import('./gemini-native')
    return new mod.GeminiNativeProvider(config)
  }

  function error(status: number) {
    return Object.assign(new Error(`http ${status}`), { response: { status } })
  }

  function dailyQuotaError() {
    return Object.assign(new Error('http 429'), {
      response: { status: 429 },
      data: {
        error: {
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
            },
          ],
        },
      },
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('succeeds on the first attempt without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse)
    vi.stubGlobal('$fetch', fetchMock)
    const provider = await freshProvider()
    const promise = provider.extract(req)
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ propertyType: 'haus' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends maxOutputTokens in generationConfig, falling back to 4096', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse)
    vi.stubGlobal('$fetch', fetchMock)
    const provider = await freshProvider()
    const promise = provider.extract(req)
    await vi.runAllTimersAsync()
    await promise
    const [, options] = fetchMock.mock.calls[0]!
    expect((options.body as { generationConfig: { maxOutputTokens: number } }).generationConfig.maxOutputTokens).toBe(4096)
  })

  it('respects an explicit maxTokens override', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse)
    vi.stubGlobal('$fetch', fetchMock)
    vi.resetModules()
    const mod = await import('./gemini-native')
    const provider = new mod.GeminiNativeProvider({ ...config, maxTokens: 2048 })
    const promise = provider.extract(req)
    await vi.runAllTimersAsync()
    await promise
    const [, options] = fetchMock.mock.calls[0]!
    expect((options.body as { generationConfig: { maxOutputTokens: number } }).generationConfig.maxOutputTokens).toBe(2048)
  })

  it('retries on 429 and returns the result once it succeeds', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(error(429))
      .mockRejectedValueOnce(error(429))
      .mockResolvedValueOnce(okResponse)
    vi.stubGlobal('$fetch', fetchMock)
    const provider = await freshProvider()
    const promise = provider.extract(req)
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ propertyType: 'haus' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('gives up after MAX_RETRIES consecutive 429s and rethrows instead of returning null', async () => {
    // Rethrown (not swallowed to null) so reprocess.ts's per-candidate catch
    // skips the attempt without counting it toward llmFailures — a capacity
    // outage must never permanently downgrade an auction to rules-only.
    const fetchMock = vi.fn().mockRejectedValue(error(429))
    vi.stubGlobal('$fetch', fetchMock)
    const provider = await freshProvider()
    const promise = provider.extract(req)
    // Attach a handler before the timers drain — the rejection settles
    // mid-drain, and without this Node briefly flags it as an unhandled
    // rejection (only a harness timing artifact, not a real bug) before the
    // `expect(...).rejects` below attaches its own handler.
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toThrow('http 429')
    expect(fetchMock).toHaveBeenCalledTimes(4) // 1 initial attempt + 3 retries
  })

  it('does not retry Gemini daily quota exhaustion', async () => {
    const fetchMock = vi.fn().mockRejectedValue(dailyQuotaError())
    vi.stubGlobal('$fetch', fetchMock)
    const provider = await freshProvider()
    const promise = provider.extract(req)
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toThrow('http 429')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a non-429 failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(error(500))
    vi.stubGlobal('$fetch', fetchMock)
    const provider = await freshProvider()
    const promise = provider.extract(req)
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('paces concurrent calls at least MIN_REQUEST_GAP_MS apart', async () => {
    const startTimes: number[] = []
    const fetchMock = vi.fn().mockImplementation(async () => {
      startTimes.push(Date.now())
      return okResponse
    })
    vi.stubGlobal('$fetch', fetchMock)
    const provider = await freshProvider()
    const p1 = provider.extract(req)
    const p2 = provider.extract(req)
    await vi.runAllTimersAsync()
    await Promise.all([p1, p2])
    expect(startTimes).toHaveLength(2)
    expect(startTimes[1]! - startTimes[0]!).toBeGreaterThanOrEqual(12_500)
  })
})

describe('isGeminiDailyQuotaError', () => {
  it('detects the free-tier per-day quota id', () => {
    expect(isGeminiDailyQuotaError({
      data: {
        error: {
          details: [
            {
              violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
            },
          ],
        },
      },
    })).toBe(true)
  })

  it('ignores non-daily quota errors', () => {
    expect(isGeminiDailyQuotaError({
      data: {
        error: {
          details: [
            {
              violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
            },
          ],
        },
      },
    })).toBe(false)
  })
})
