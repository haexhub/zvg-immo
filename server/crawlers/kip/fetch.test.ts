import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchKipPage } from './fetch'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchKipPage', () => {
  it('starts the request timeout when the queued request is sent, not when it is queued', async () => {
    vi.useFakeTimers()
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const timeoutsAtSend: number[] = []
    vi.stubGlobal('fetch', vi.fn(async () => {
      timeoutsAtSend.push(timeout.mock.calls.length)
      return new Response('ok')
    }))

    const all = Promise.all(['a', 'b', 'c'].map((p) => fetchKipPage(`https://www.kip.net/${p}`, 'GET', undefined, null)))
    await vi.advanceTimersByTimeAsync(10_000)
    await all

    // One fresh signal per send; a signal created up front would already be
    // counting down while the later requests wait out the crawl delay.
    expect(timeoutsAtSend).toEqual([1, 2, 3])
  })
})
