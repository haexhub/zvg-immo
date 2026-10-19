import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeFetchError, isTransientFetchError, retryTransient, TransientUpstreamError } from './transient-retry'

const fetchFailed = (code?: string) =>
  new TypeError('fetch failed', code ? { cause: Object.assign(new Error(`connect ${code}`), { code }) } : undefined)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('isTransientFetchError', () => {
  it('accepts dropped connections, DNS hiccups and marked upstream failures', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']) {
      expect(isTransientFetchError(fetchFailed(code))).toBe(true)
    }
    expect(isTransientFetchError(fetchFailed())).toBe(true)
    expect(isTransientFetchError(new TransientUpstreamError('HTTP 503'))).toBe(true)
  })

  it('rejects permanent failures and plain errors such as a 4xx', () => {
    expect(isTransientFetchError(fetchFailed('ENOTFOUND'))).toBe(false)
    expect(isTransientFetchError(fetchFailed('UND_ERR_ABORTED'))).toBe(false)
    expect(isTransientFetchError(new Error('HTTP 404'))).toBe(false)
    expect(isTransientFetchError(new DOMException('aborted', 'TimeoutError'))).toBe(false)
  })
})

describe('describeFetchError', () => {
  it('appends the network code hidden in the cause', () => {
    expect(describeFetchError(fetchFailed('ECONNRESET'))).toBe('fetch failed (ECONNRESET)')
    expect(describeFetchError(new Error('HTTP 403'))).toBe('HTTP 403')
  })
})

describe('retryTransient', () => {
  it('retries a transient failure up to twice and returns the first success', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(fetchFailed('ECONNRESET')).mockRejectedValueOnce(new TransientUpstreamError('HTTP 502')).mockResolvedValue('ok')

    const result = retryTransient(attempt)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(await result).toBe('ok')
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('gives up after two retries with the last error', async () => {
    const attempt = vi.fn(async () => { throw fetchFailed('ETIMEDOUT') })

    const result = retryTransient(attempt).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(await result).toMatchObject({ message: 'fetch failed', cause: { code: 'ETIMEDOUT' } })
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('rethrows a non-transient error without retrying', async () => {
    const attempt = vi.fn(async () => { throw new Error('HTTP 429') })

    await expect(retryTransient(attempt)).rejects.toThrow('HTTP 429')
    expect(attempt).toHaveBeenCalledTimes(1)
  })
})
