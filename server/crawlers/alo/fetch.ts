import { SourceRateLimitedError } from '~/server/utils/source-rate-limit'
import { CRAWL_DELAY_MS, UA } from './constants'

const FETCH_TIMEOUT_MS = 20_000
const FETCH_RETRIES = 2

// alo.bg answers HTTP 429 well below our fixed 1 req/s. Rather than guess its
// limit, the pacing adapts (AIMD): every 429 doubles the gap between requests
// and pauses everyone for a growing time; a long run of successes halves the
// gap again, down to the 1 s floor. If it keeps refusing, the breaker below
// stops asking altogether for a while instead of burning a retry budget on
// every single auction.
//
// Detail pages are the exception (verified live, 2026-10-18): after a few dozen
// requests the IP gets `xalo: ad_captcha_show` with `Retry-After: 3600`, and
// list pages keep working. Retrying through that only extends the block, so a
// 429 that names a Retry-After opens the breaker for exactly that long at once.
const MAX_GAP_MS = 30_000
const FIRST_PAUSE_MS = 10_000
const MAX_PAUSE_MS = 5 * 60_000
const SUCCESSES_PER_SPEEDUP = 20
/** Consecutive 429s after which the breaker opens … */
const BREAKER_THRESHOLD = 6
/** … and for how long it fails fast before one more probe is allowed. */
const BREAKER_OPEN_MS = 30 * 60_000
const RATE_LIMIT_ATTEMPTS = 3
const MAX_RETRY_AFTER_MS = 6 * 60 * 60_000

let gapMs = CRAWL_DELAY_MS
let pauseUntil = 0
let breakerUntil = 0
let consecutive429 = 0
let successStreak = 0
let okSinceBlock = 0

/** `Retry-After` as milliseconds (delta-seconds or HTTP-date), or null when absent/unusable. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after')?.trim()
  if (!raw) return null
  const ms = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now()
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : null
}

function openBreakerFor(ms: number): void {
  breakerUntil = Date.now() + ms
  console.warn(`[alo] blocked with HTTP 429 after ${okSinceBlock} successful request(s); not asking again for ${Math.round(ms / 60_000)} min`)
  okSinceBlock = 0
}

function noteRateLimited(): void {
  consecutive429++
  successStreak = 0
  gapMs = Math.min(gapMs * 2, MAX_GAP_MS)
  pauseUntil = Date.now() + Math.min(FIRST_PAUSE_MS * 2 ** (consecutive429 - 1), MAX_PAUSE_MS)
  if (consecutive429 >= BREAKER_THRESHOLD) {
    breakerUntil = Date.now() + BREAKER_OPEN_MS
    // Half-open afterwards: one more 429 re-opens it after a short pause.
    consecutive429 = BREAKER_THRESHOLD - 2
  }
}

function noteSuccess(): void {
  consecutive429 = 0
  okSinceBlock++
  if (gapMs > CRAWL_DELAY_MS && ++successStreak >= SUCCESSES_PER_SPEEDUP) {
    successStreak = 0
    gapMs = Math.max(CRAWL_DELAY_MS, Math.floor(gapMs / 2))
  }
}

/** Serialises every request to alo.bg through one queue with an adaptive gap
 *  (never below CRAWL_DELAY_MS) — same pattern as kip/fetch.ts and
 *  gb/detail.ts. Both list.ts's page walk (~1,140 pages per full cycle) and
 *  detail.ts's enrichOne (which the enrich task runs at ENRICH_CONCURRENCY=8
 *  across several auctions at once) go through this single function, so the
 *  pacing holds project-wide regardless of how many callers are in flight. */
let queue: Promise<unknown> = Promise.resolve()
let lastFetchAt = 0

function throttledFetch(url: string): Promise<Response> {
  const run = queue.then(async () => {
    if (Date.now() < breakerUntil) {
      throw new SourceRateLimitedError('alo.bg rate limit: backing off, not sending requests for now')
    }
    const wait = Math.max(lastFetchAt + gapMs, pauseUntil) - Date.now()
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
 * Throttled GET, retrying transient failures (timeout, network error, 5xx).
 * A 429 is retried too, but through the shared pause/backoff above rather than
 * a per-call sleep; once it persists it surfaces as SourceRateLimitedError.
 * Other non-retryable responses are returned as-is so the caller can branch
 * on the status — list.ts has to read a 404 as end-of-pagination.
 */
export async function fetchAloPage(url: string): Promise<Response> {
  let rateLimited = 0
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await throttledFetch(url)
    } catch (err) {
      if (err instanceof SourceRateLimitedError || attempt >= FETCH_RETRIES) throw err
    }
    if (res) {
      if (res.status === 429) {
        // Before the first await: callers already queued behind this request
        // must see the new pause/breaker when they start.
        const blockedFor = retryAfterMs(res)
        if (blockedFor != null) openBreakerFor(blockedFor)
        else noteRateLimited()
        await res.arrayBuffer().catch(() => {})
        if (blockedFor != null) {
          throw new SourceRateLimitedError(`alo.bg rate limit: HTTP 429, retry after ${Math.round(blockedFor / 60_000)} min`)
        }
        if (++rateLimited >= RATE_LIMIT_ATTEMPTS || Date.now() < breakerUntil) {
          throw new SourceRateLimitedError(`alo.bg rate limit: HTTP 429 after ${rateLimited} attempt(s)`)
        }
        continue
      }
      if (res.ok || res.status < 500) {
        if (res.ok) noteSuccess()
        return res
      }
      if (attempt >= FETCH_RETRIES) return res
      await res.arrayBuffer().catch(() => {})
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
  }
}
