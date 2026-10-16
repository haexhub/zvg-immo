import { CRAWL_DELAY_MS, UA } from './constants'

const FETCH_TIMEOUT_MS = 20_000
const FETCH_RETRIES = 2

/** 429 is retried on the same exponential schedule as a 5xx: alo.bg sends no
 *  Retry-After with it (verified live), and treating it as fatal would throw
 *  away an entire page walk mid-crawl. */
function isTransient(status: number): boolean {
  return status >= 500 || status === 429
}

/** Serialises every request to alo.bg through one queue with a minimum
 *  CRAWL_DELAY_MS gap — same pattern as kip/fetch.ts and gb/detail.ts. Both
 *  list.ts's page walk (~1,140 pages per full cycle) and detail.ts's enrichOne
 *  (which the enrich task runs at ENRICH_CONCURRENCY=8 across several auctions
 *  at once) go through this single function, so the pacing holds project-wide
 *  regardless of how many callers are in flight. */
let queue: Promise<unknown> = Promise.resolve()
let lastFetchAt = 0

function throttledFetch(url: string): Promise<Response> {
  const run = queue.then(async () => {
    const wait = lastFetchAt + CRAWL_DELAY_MS - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastFetchAt = Date.now()
    return fetch(url, {
      headers: { Accept: 'text/html', 'Accept-Language': 'bg,en;q=0.8', 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  })
  // Keep the queue alive even if this fetch fails, so later callers aren't
  // stuck behind a rejected promise forever.
  queue = run.catch(() => undefined)
  return run
}

/**
 * Throttled GET, retrying transient failures (timeout, network error, 5xx,
 * 429). Non-retryable responses are returned as-is rather than thrown so the
 * caller can branch on the status — list.ts has to read a 404 as
 * end-of-pagination rather than as an error.
 */
export async function fetchAloPage(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await throttledFetch(url)
      if (res.ok || !isTransient(res.status)) return res
    } catch (err) {
      if (attempt >= FETCH_RETRIES) throw err
    }
    if (res) {
      if (attempt >= FETCH_RETRIES) return res
      await res.arrayBuffer().catch(() => {})
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
  }
}
