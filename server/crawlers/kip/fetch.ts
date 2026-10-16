import { CRAWL_DELAY_MS, UA } from './constants'

const FETCH_TIMEOUT_MS = 20_000
const FETCH_RETRIES = 2

/** Serialises every fetch against kip.net through one queue with a minimum
 *  CRAWL_DELAY_MS gap, honouring the site's robots.txt "Crawl-delay: 1" —
 *  same pattern as gb/detail.ts's onlineFetch. Both list.ts's pagination loop
 *  and detail.ts's enrichOne (which the enrich task can call with concurrency
 *  across several auctions at once) go through this single function, so the
 *  delay holds project-wide regardless of how many callers are in flight. */
let queue: Promise<unknown> = Promise.resolve()
let lastFetchAt = 0

async function throttledFetch(url: string, init: RequestInit): Promise<Response> {
  const run = queue.then(async () => {
    const wait = lastFetchAt + CRAWL_DELAY_MS - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastFetchAt = Date.now()
    return fetch(url, init)
  })
  // Keep the queue alive even if this fetch fails, so later callers aren't
  // stuck behind a rejected promise forever.
  queue = run.catch(() => undefined)
  return run
}

export interface KipPageResult {
  html: string
  /** Set-Cookie captured from the response (PHPSESSID) — reusing it on the
   *  next request is what keeps kip.net's own "seite" (page) pagination
   *  stable instead of drifting between requests; see list.ts. */
  cookie: string | null
}

/** Retries transient failures (timeout, network error, 5xx); 4xx responses
 *  are not retried since a second attempt won't succeed — same convention as
 *  gb/list.ts and dga-ag/list.ts. */
export async function fetchKipPage(
  url: string,
  method: 'GET' | 'POST',
  body: URLSearchParams | undefined,
  cookie: string | null,
): Promise<KipPageResult> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await throttledFetch(url, {
        method,
        headers: {
          Accept: 'text/html',
          'Accept-Language': 'de-DE,de;q=0.9',
          'User-Agent': UA,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: body?.toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.ok) {
        const setCookie = res.headers.getSetCookie().map((c) => c.split(';')[0]!)
        return { html: await res.text(), cookie: setCookie.length > 0 ? setCookie.join('; ') : cookie }
      }
    } catch (err) {
      if (attempt >= FETCH_RETRIES) throw err
    }
    if (res && !res.ok) {
      if (res.status < 500) throw new Error(`kip.net ${url}: HTTP ${res.status}`)
      if (attempt >= FETCH_RETRIES) throw new Error(`kip.net ${url}: HTTP ${res.status}`)
      await res.arrayBuffer().catch(() => {})
    }
  }
}
