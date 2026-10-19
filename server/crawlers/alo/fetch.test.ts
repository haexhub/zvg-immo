import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// fetch.ts keeps its throttle queue in module state, so each test gets a fresh
// copy. Fake timers keep the 1s crawl delay and the exponential backoff from
// making these tests take seconds of real time.
async function loadFetch() {
  vi.resetModules()
  return (await import('./fetch')).fetchAloPage
}

const tooMany = () => new Response('', { status: 429 })

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

  it('widens the gap after a 429 and narrows it again after a run of successes', async () => {
    const calledAt: number[] = []
    let throttle = true
    vi.stubGlobal('fetch', vi.fn(async () => {
      calledAt.push(Date.now())
      if (throttle) { throttle = false; return tooMany() }
      return new Response('ok')
    }))
    const fetchAloPage = await loadFetch()

    const first = fetchAloPage('https://www.alo.bg/a')
    await vi.advanceTimersByTimeAsync(60_000)
    await first
    // 429, then the retry after the shared pause: gap doubled to 2 s, pause 10 s.
    expect(calledAt[1]! - calledAt[0]!).toBeGreaterThanOrEqual(10_000)

    for (let i = 0; i < 25; i++) {
      const p = fetchAloPage(`https://www.alo.bg/n${i}`)
      await vi.advanceTimersByTimeAsync(5_000)
      await p
    }
    // Two overlapping callers show the gap that is in force now: back at the 1 s floor.
    calledAt.length = 0
    const pair = Promise.all([fetchAloPage('https://www.alo.bg/x'), fetchAloPage('https://www.alo.bg/y')])
    await vi.advanceTimersByTimeAsync(10_000)
    await pair
    expect(calledAt[1]! - calledAt[0]!).toBeGreaterThanOrEqual(1_000)
    expect(calledAt[1]! - calledAt[0]!).toBeLessThan(2_000)
  })

  it('pauses every caller for the shared back-off, not just the one that was throttled', async () => {
    const calledAt: number[] = []
    let first = true
    vi.stubGlobal('fetch', vi.fn(async () => {
      calledAt.push(Date.now())
      if (first) { first = false; return tooMany() }
      return new Response('ok')
    }))
    const fetchAloPage = await loadFetch()

    const all = Promise.all([fetchAloPage('https://www.alo.bg/a'), fetchAloPage('https://www.alo.bg/b')])
    await vi.advanceTimersByTimeAsync(120_000)
    await all

    // The second caller's request was already queued behind the 429 and had to sit out the pause too.
    expect(calledAt[1]! - calledAt[0]!).toBeGreaterThanOrEqual(10_000)
  })

  it('stops asking once alo keeps refusing, then fails fast without any request', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => tooMany())
    vi.stubGlobal('fetch', fetchMock)
    const fetchAloPage = await loadFetch()
    const { SourceRateLimitedError } = await import('~/server/utils/source-rate-limit')

    // Each auction gets 3 attempts; the second one's last 429 is the 6th in a row and opens the breaker.
    for (const id of ['a', 'b']) {
      const failed = fetchAloPage(`https://www.alo.bg/${id}`).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      expect(await failed).toBeInstanceOf(SourceRateLimitedError)
    }
    expect(fetchMock).toHaveBeenCalledTimes(6)

    const third = fetchAloPage('https://www.alo.bg/c').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await third).toBeInstanceOf(SourceRateLimitedError)
    expect(fetchMock).toHaveBeenCalledTimes(6) // breaker open: nothing was sent
  })

  it('resets the success count when the headerless breaker opens', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++
      if (n <= 3) return new Response('ok')
      if (n <= 9) return tooMany()
      return new Response('', { status: 429, headers: { 'retry-after': '3600' } })
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchAloPage = await loadFetch()

    for (const id of ['a', 'b', 'c']) {
      const succeeded = fetchAloPage(`https://www.alo.bg/${id}`)
      await vi.advanceTimersByTimeAsync(5_000)
      await succeeded
    }

    // Two calls consume six headerless 429s and open the regular breaker.
    for (const id of ['d', 'e']) {
      const failed = fetchAloPage(`https://www.alo.bg/${id}`).catch(() => undefined)
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      await failed
    }

    // The first probe after that breaker is a Retry-After 429. Its warning
    // must count only requests since the newly opened breaker, not the three
    // successful requests from before it.
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    const probe = fetchAloPage('https://www.alo.bg/f').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5_000)
    await probe
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('after 0 successful request(s)'))
    warn.mockRestore()
  })

  it('opens the breaker at once for the Retry-After alo names — retrying a captcha block only extends it', async () => {
    const blocked = () => new Response('', { status: 429, headers: { 'retry-after': '3600' } })
    const fetchMock = vi.fn().mockImplementation(async () => blocked())
    vi.stubGlobal('fetch', fetchMock)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchAloPage = await loadFetch()
    const { SourceRateLimitedError } = await import('~/server/utils/source-rate-limit')

    const first = fetchAloPage('https://www.alo.bg/a').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await first).toBeInstanceOf(SourceRateLimitedError)
    expect(fetchMock).toHaveBeenCalledTimes(1) // no retry after the block was announced

    // Still blocked 59 minutes later: nothing is sent.
    await vi.advanceTimersByTimeAsync(59 * 60_000)
    const second = fetchAloPage('https://www.alo.bg/b').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await second).toBeInstanceOf(SourceRateLimitedError)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // After the hour one probe goes out again.
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    const third = fetchAloPage('https://www.alo.bg/c').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)
    await third
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('after 0 successful request(s)'))
    warn.mockRestore()
  })

  it("reports how many requests got through before the block, to learn alo's quota", async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => (++n <= 3 ? new Response('ok') : new Response('', { status: 429, headers: { 'retry-after': '3600' } }))))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchAloPage = await loadFetch()

    for (const id of ['a', 'b', 'c', 'd']) {
      const p = fetchAloPage(`https://www.alo.bg/${id}`).catch(() => undefined)
      await vi.advanceTimersByTimeAsync(5_000)
      await p
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('after 3 successful request(s)'))
    warn.mockRestore()
  })
  it('doubles the pause when the probe after a block is refused again, and starts over after a success', async () => {
    const blocked = () => new Response('', { status: 429, headers: { 'retry-after': '3600' } })
    let answer: () => Response = blocked
    const fetchMock = vi.fn(async () => answer())
    vi.stubGlobal('fetch', fetchMock)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchAloPage = await loadFetch()
    const probe = async (id: string) => {
      const p = fetchAloPage(`https://www.alo.bg/${id}`).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(5_000)
      return p
    }

    await probe('a') // block #1: 60 min
    await vi.advanceTimersByTimeAsync(61 * 60_000)
    await probe('b') // refused again without any success: block #2, 120 min
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('block #2'))
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('120 min'))

    await vi.advanceTimersByTimeAsync(119 * 60_000)
    await probe('c')
    expect(fetchMock).toHaveBeenCalledTimes(2) // still inside the doubled pause: nothing sent

    await vi.advanceTimersByTimeAsync(2 * 60_000)
    answer = () => new Response('ok')
    await probe('d')
    expect(fetchMock).toHaveBeenCalledTimes(3)

    answer = blocked // a success happened since the last block, so the next one is a fresh #1
    await probe('e')
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('after 1 successful request(s); not asking again for 60 min'))
    warn.mockRestore()
  })

  it('does not shorten an escalated pause when the next Retry-After is smaller', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => calls++ === 0
      ? new Response('', { status: 429, headers: { 'retry-after': '21600' } })
      : new Response('', { status: 429, headers: { 'retry-after': '3600' } }))
    vi.stubGlobal('fetch', fetchMock)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchAloPage = await loadFetch()

    const first = fetchAloPage('https://www.alo.bg/a').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5_000)
    await first
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000)

    const second = fetchAloPage('https://www.alo.bg/b').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5_000)
    await second
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('720 min'))

    await vi.advanceTimersByTimeAsync(11 * 60 * 60_000 + 59 * 60_000)
    const third = fetchAloPage('https://www.alo.bg/c').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5_000)
    await third
    expect(fetchMock).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('keeps list pages walking while detail pages are blocked', async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('/obiavi/')
        ? new Response('list')
        : new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchAloPage = await loadFetch()
    const { SourceRateLimitedError } = await import('~/server/utils/source-rate-limit')

    const detail = fetchAloPage('https://www.alo.bg/some-ad-123').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await detail).toBeInstanceOf(SourceRateLimitedError)

    const list = fetchAloPage('https://www.alo.bg/obiavi/imoti-prodajbi/apartamenti-stai/?region_id=22&page=2')
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await list).status).toBe(200)

    const again = fetchAloPage('https://www.alo.bg/other-ad-456').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await again).toBeInstanceOf(SourceRateLimitedError)
    expect(fetchMock).toHaveBeenCalledTimes(2) // the second detail request was never sent
  })

  it('keeps headerless breaker counts separate for list and detail pages', async () => {
    const fetchMock = vi.fn(async () => tooMany())
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchAloPage = await loadFetch()
    const { SourceRateLimitedError } = await import('~/server/utils/source-rate-limit')

    for (const [kind, id] of [['list', 'page-1'], ['detail', 'ad-1']] as const) {
      const url = kind === 'list'
        ? `https://www.alo.bg/obiavi/imoti-prodajbi/apartamenti-stai/?page=${id}`
        : `https://www.alo.bg/${id}`
      const failed = fetchAloPage(url).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      expect(await failed).toBeInstanceOf(SourceRateLimitedError)
    }

    const listAgain = fetchAloPage('https://www.alo.bg/obiavi/imoti-prodajbi/apartamenti-stai/?page=2').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(await listAgain).toBeInstanceOf(SourceRateLimitedError)
    expect(fetchMock).toHaveBeenCalledTimes(9)
  })
})
