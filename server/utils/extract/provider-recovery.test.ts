import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForProviderRecovery } from './provider-recovery'

const proxy = { provider: 'claude-proxy' as const, baseUrl: 'http://proxy:8080/', apiKey: '', model: 'm' }

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('waitForProviderRecovery', () => {
  it('resolves true as soon as /healthz answers again', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)

    const pending = waitForProviderRecovery(proxy)
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(pending).resolves.toBe(true)
    expect(fetchMock).toHaveBeenLastCalledWith('http://proxy:8080/healthz', expect.anything())
  })

  it('gives up with false when the provider stays down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    const pending = waitForProviderRecovery(proxy, { timeoutMs: 20_000, intervalMs: 2_000 })
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(pending).resolves.toBe(false)
  })

  it('shares one probe between concurrent lanes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const a = waitForProviderRecovery(proxy)
    const b = waitForProviderRecovery(proxy)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not wait for a provider without a health endpoint', async () => {
    await expect(waitForProviderRecovery({ ...proxy, provider: 'gemini-native' })).resolves.toBe(false)
    await expect(waitForProviderRecovery(null)).resolves.toBe(false)
  })
})
