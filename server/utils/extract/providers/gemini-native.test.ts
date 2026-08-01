import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionRequest } from '../llm'
import { parseGeminiExtractionResponse, toGeminiParts } from './gemini-native'

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

  /** 429 carrying a QuotaFailure detail, as the live API returns it. */
  function quotaError(quotaId: string) {
    return Object.assign(error(429), {
      data: {
        error: {
          status: 'RESOURCE_EXHAUSTED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] }],
        },
      },
    })
  }

  const dailyQuotaError = () => quotaError('GenerateRequestsPerDayPerProjectPerModel-FreeTier')
  const minuteQuotaError = () => quotaError('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')

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
    promise.catch(() => {})
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

  // The whole point of telling the two 429 flavours apart: a per-day quota
  // cannot clear before midnight Pacific, so the 3 retries at 12.5 s pacing
  // were ~50 s burned per candidate. Measured in prod 2026-07-31.
  it('does not retry a per-day quota and rethrows immediately', async () => {
    const fetchMock = vi.fn().mockRejectedValue(dailyQuotaError())
    vi.stubGlobal('$fetch', fetchMock)
    const provider = await freshProvider()
    const promise = provider.extract(req)
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toThrow('http 429')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('still retries a per-minute rate limit', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(minuteQuotaError())
      .mockResolvedValueOnce(okResponse)
    vi.stubGlobal('$fetch', fetchMock)
    const provider = await freshProvider()
    const promise = provider.extract(req)
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ propertyType: 'haus' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry and surfaces a non-429 failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(error(500))
    vi.stubGlobal('$fetch', fetchMock)
    const provider = await freshProvider()
    const promise = provider.extract(req)
    promise.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toMatchObject({ name: 'LlmProviderError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('calls onRequestError for a non-429 failure but not for a 429 (which rethrows instead)', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(error(500)))
    const provider = await freshProvider()
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

  // The quota the pacing exists to respect is
  // `GenerateRequestsPerMinutePerProjectPerModel-FreeTier` — per API key (each
  // key is its own Google project) and per model. A single process-wide gate
  // therefore throttled unrelated keys against each other, which is exactly
  // what made a chain of four keys no faster than one.
  it('does not pace two different API keys against each other', async () => {
    const startTimes: number[] = []
    vi.stubGlobal('$fetch', vi.fn().mockImplementation(async () => {
      startTimes.push(Date.now())
      return okResponse
    }))
    vi.resetModules()
    const mod = await import('./gemini-native')
    const first = new mod.GeminiNativeProvider({ ...config, apiKey: 'key-a' })
    const second = new mod.GeminiNativeProvider({ ...config, apiKey: 'key-b' })
    const p1 = first.extract(req)
    const p2 = second.extract(req)
    await vi.runAllTimersAsync()
    await Promise.all([p1, p2])
    expect(startTimes).toHaveLength(2)
    expect(startTimes[1]! - startTimes[0]!).toBeLessThan(12_500)
  })

  it('still paces the same key across two provider instances', async () => {
    const startTimes: number[] = []
    vi.stubGlobal('$fetch', vi.fn().mockImplementation(async () => {
      startTimes.push(Date.now())
      return okResponse
    }))
    vi.resetModules()
    const mod = await import('./gemini-native')
    const first = new mod.GeminiNativeProvider({ ...config, apiKey: 'same-key' })
    const second = new mod.GeminiNativeProvider({ ...config, apiKey: 'same-key' })
    const p1 = first.extract(req)
    const p2 = second.extract(req)
    await vi.runAllTimersAsync()
    await Promise.all([p1, p2])
    expect(startTimes[1]! - startTimes[0]!).toBeGreaterThanOrEqual(12_500)
  })

  // TPM_CAP is 250_000 — see gemini-native.ts. GenerateRequestsPerMinutePer-
  // ProjectPerModel-FreeTier (the RPM gate above) and the token quota are
  // independent: a key can sit well under its request limit while its
  // Gutachten PDFs blow the token one (measured in prod 2026-08-01: 6/15 RPM,
  // 298.92k/250k TPM).
  function okResponseWithTokens(promptTokenCount: number) {
    return { ...okResponse, usageMetadata: { promptTokenCount } }
  }

  it('does not delay a fresh bucket even for an oversized first request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponseWithTokens(300_000))
    vi.stubGlobal('$fetch', fetchMock)
    const provider = await freshProvider()
    const promise = provider.extract(req)
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ propertyType: 'haus' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('waits out the trailing minute once recorded token usage crosses TPM_CAP', async () => {
    const startTimes: number[] = []
    const fetchMock = vi.fn().mockImplementation(async () => {
      startTimes.push(Date.now())
      return okResponseWithTokens(260_000)
    })
    vi.stubGlobal('$fetch', fetchMock)
    const provider = await freshProvider()
    const p1 = provider.extract(req)
    await vi.runAllTimersAsync()
    await p1
    const p2 = provider.extract(req)
    await vi.runAllTimersAsync()
    await p2
    expect(startTimes).toHaveLength(2)
    // Far past the 12.5s RPM gap — the token gate is what forces this wait.
    expect(startTimes[1]! - startTimes[0]!).toBeGreaterThanOrEqual(60_000)
  })

  it('does not wait once the token window is under TPM_CAP', async () => {
    const startTimes: number[] = []
    const fetchMock = vi.fn().mockImplementation(async () => {
      startTimes.push(Date.now())
      return okResponseWithTokens(1_000)
    })
    vi.stubGlobal('$fetch', fetchMock)
    const provider = await freshProvider()
    const p1 = provider.extract(req)
    await vi.runAllTimersAsync()
    await p1
    const p2 = provider.extract(req)
    await vi.runAllTimersAsync()
    await p2
    expect(startTimes[1]! - startTimes[0]!).toBeLessThan(60_000)
  })

  it('does not pace the token budget of one key against another', async () => {
    const startTimes: number[] = []
    vi.stubGlobal('$fetch', vi.fn().mockImplementation(async () => {
      startTimes.push(Date.now())
      return okResponseWithTokens(260_000)
    }))
    vi.resetModules()
    const mod = await import('./gemini-native')
    const first = new mod.GeminiNativeProvider({ ...config, apiKey: 'key-a' })
    const second = new mod.GeminiNativeProvider({ ...config, apiKey: 'key-b' })
    const p1 = first.extract(req)
    await vi.runAllTimersAsync()
    await p1
    const p2 = second.extract(req)
    await vi.runAllTimersAsync()
    await p2
    expect(startTimes).toHaveLength(2)
    expect(startTimes[1]! - startTimes[0]!).toBeLessThan(60_000)
  })

  it('paces the same key separately per model, matching the per-model quota', async () => {
    const startTimes: number[] = []
    vi.stubGlobal('$fetch', vi.fn().mockImplementation(async () => {
      startTimes.push(Date.now())
      return okResponse
    }))
    vi.resetModules()
    const mod = await import('./gemini-native')
    const flash = new mod.GeminiNativeProvider({ ...config, apiKey: 'k', model: 'gemini-flash-latest' })
    const lite = new mod.GeminiNativeProvider({ ...config, apiKey: 'k', model: 'gemini-flash-lite-latest' })
    const p1 = flash.extract(req)
    const p2 = lite.extract(req)
    await vi.runAllTimersAsync()
    await Promise.all([p1, p2])
    expect(startTimes[1]! - startTimes[0]!).toBeLessThan(12_500)
  })
})
