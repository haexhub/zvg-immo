import { CRAWL_DELAY_MS } from './constants'

/** Serialises every fetch against sales.bcpea.org through one queue with a
 *  minimum CRAWL_DELAY_MS gap — same pattern as kip/fetch.ts. Both list.ts's
 *  pagination loop and detail.ts's enrichOne (which the enrich task can call
 *  with concurrency across several auctions at once) go through this single
 *  function, so the delay holds project-wide regardless of how many callers
 *  are in flight. */
let queue: Promise<unknown> = Promise.resolve()
let lastFetchAt = 0

export async function throttledFetch(url: string, init: RequestInit): Promise<Response> {
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
