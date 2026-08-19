import { CRAWL_DELAY_MS, UA } from './constants'

const FETCH_TIMEOUT_MS = 20_000
const FETCH_RETRIES = 2

/** Serialises every request to bulgarianhouse.com through one queue with a
 *  minimum CRAWL_DELAY_MS gap — same pattern as kip/fetch.ts. Both list.ts's
 *  pagination loop and detail.ts's enrichOne go through here, and that second
 *  caller is why the queue has to be shared: the enrich task runs
 *  ENRICH_CONCURRENCY (8) workers, so a per-call delay would still put eight
 *  parallel requests on this small PHP site. */
let queue: Promise<unknown> = Promise.resolve()
let lastFetchAt = 0

async function throttledFetch(url: string): Promise<Response> {
  const run = queue.then(async () => {
    const wait = lastFetchAt + CRAWL_DELAY_MS - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastFetchAt = Date.now()
    return fetch(url, {
      headers: { Accept: 'text/html', 'Accept-Language': 'en', 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  })
  // Keep the queue alive even if this fetch fails, so later callers aren't
  // stuck behind a rejected promise forever.
  queue = run.catch(() => undefined)
  return run
}

/** Retries transient failures (timeout, network error, 5xx); 4xx responses are
 *  not retried since a second attempt won't succeed — same convention as
 *  kip/fetch.ts and dga-ag/list.ts. `label` only names the page kind in the
 *  error message ('list' / 'detail'). */
export async function fetchPageHtml(url: string, label: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await throttledFetch(url)
      if (res.ok) return await res.text()
    } catch (err) {
      if (attempt >= FETCH_RETRIES) throw err
    }
    if (res && !res.ok) {
      if (res.status < 500) throw new Error(`bulgarianhouse.com ${label} HTTP ${res.status} for ${url}`)
      if (attempt >= FETCH_RETRIES) throw new Error(`bulgarianhouse.com ${label} HTTP ${res.status} for ${url}`)
      await res.arrayBuffer().catch(() => {})
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
  }
}
