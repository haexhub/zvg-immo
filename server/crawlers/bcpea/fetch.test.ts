import { afterEach, describe, expect, it, vi } from 'vitest'
import { throttledFetch } from './fetch'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('throttledFetch', () => {
  it('starts the request timeout when the queued request is sent, not when it is queued', async () => {
    vi.useFakeTimers()
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const timeoutsAtSend: number[] = []
    vi.stubGlobal('fetch', vi.fn(async () => {
      timeoutsAtSend.push(timeout.mock.calls.length)
      return new Response('ok')
    }))

    const all = Promise.all(['a', 'b', 'c'].map((p) => throttledFetch(`https://sales.bcpea.org/${p}`, {})))
    await vi.advanceTimersByTimeAsync(10_000)
    await all

    expect(timeoutsAtSend).toEqual([1, 2, 3])
  })
})
