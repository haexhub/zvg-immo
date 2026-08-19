import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// fetch.ts keeps its throttle queue in module state, so each test gets a fresh
// copy. Fake timers keep the 1s crawl delay and the exponential backoff from
// making these tests take seconds of real time.
async function loadFetch() {
  vi.resetModules()
  return (await import('./fetch')).fetchAloPage
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('fetchAloPage', () => {
  it('retries a 429 instead of surfacing it, so one throttled page cannot abort a whole page walk', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const fetchAloPage = await loadFetch()

    const pending = fetchAloPage('https://www.alo.bg/x')
    await vi.advanceTimersByTimeAsync(10_000)

    expect((await pending).status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns a 404 unretried so list.ts can read it as end-of-pagination', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const fetchAloPage = await loadFetch()

    const pending = fetchAloPage('https://www.alo.bg/x')
    await vi.advanceTimersByTimeAsync(10_000)

    expect((await pending).status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after the retry budget on a persistent 5xx and hands back the last response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const fetchAloPage = await loadFetch()

    const pending = fetchAloPage('https://www.alo.bg/x')
    await vi.advanceTimersByTimeAsync(30_000)

    expect((await pending).status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('paces overlapping callers by CRAWL_DELAY_MS — the enrich task runs enrichOne concurrently', async () => {
    const calledAt: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calledAt.push(Date.now())
        return new Response('ok')
      }),
    )
    const fetchAloPage = await loadFetch()

    const all = Promise.all([
      fetchAloPage('https://www.alo.bg/a'),
      fetchAloPage('https://www.alo.bg/b'),
      fetchAloPage('https://www.alo.bg/c'),
    ])
    await vi.advanceTimersByTimeAsync(30_000)
    await all

    expect(calledAt).toHaveLength(3)
    expect(calledAt[1]! - calledAt[0]!).toBeGreaterThanOrEqual(1_000)
    expect(calledAt[2]! - calledAt[1]!).toBeGreaterThanOrEqual(1_000)
  })
})
