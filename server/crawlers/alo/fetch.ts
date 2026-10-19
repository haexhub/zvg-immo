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
// A probe that is refused again without a single success in between means the
// block outlasts the announced hour (or our probes keep renewing it), so each
// such repeat doubles the pause, up to a day.
//
// List and detail pages are blocked independently: a detail block must not
// stop the page walk that finds new listings.
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
const MAX_ESCALATED_BLOCK_MS = 24 * 60 * 60_000

type PageKind = 'list' | 'detail'
interface Block {
  until: number
  /** Blocks in a row that were refused again before any request succeeded. */
  streak: number
  /** Successful requests since the last block opened. */
  ok: number
  /** Headerless 429s for this page kind used by the short breaker. */
  consecutive429: number
  /** Duration of the last announced block, used as the escalation base. */
  pauseMs: number
}
const blocks: Record<PageKind, Block> = {
  list: { until: 0, streak: 0, ok: 0, consecutive429: 0, pauseMs: 0 },
  detail: { until: 0, streak: 0, ok: 0, consecutive429: 0, pauseMs: 0 },
}

/** Listing pages live under /obiavi/; everything else is a single ad. */
function pageKind(url: string): PageKind {
  return new URL(url).pathname.startsWith('/obiavi/') ? 'list' : 'detail'
}

let gapMs = CRAWL_DELAY_MS
let pauseUntil = 0
let consecutive429 = 0
let successStreak = 0

/** `Retry-After` as milliseconds (delta-seconds or HTTP-date), or null when absent/unusable. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after')?.trim()
  if (!raw) return null
  const ms = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now()
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : null
}

function openBreakerFor(kind: PageKind, announcedMs: number): number {
  const block = blocks[kind]
  block.streak = block.ok === 0 && block.streak > 0 ? block.streak + 1 : 1
  const requestedMs = block.streak > 1 ? Math.max(announcedMs, block.pauseMs * 2) : announcedMs
  const ms = Math.min(requestedMs, MAX_ESCALATED_BLOCK_MS)
  block.pauseMs = ms
  block.until = Date.now() + ms
  console.warn(
    `[alo] ${kind} pages blocked with HTTP 429 after ${block.ok} successful request(s)` +
      `${block.streak > 1 ? ` (refused again, block #${block.streak})` : ''}; not asking again for ${Math.round(ms / 60_000)} min`,
  )
  block.ok = 0
  return ms
}

function noteRateLimited(kind: PageKind): void {
  consecutive429++
  const block = blocks[kind]
  block.consecutive429++
  successStreak = 0
  gapMs = Math.min(gapMs * 2, MAX_GAP_MS)
  pauseUntil = Date.now() + Math.min(FIRST_PAUSE_MS * 2 ** (consecutive429 - 1), MAX_PAUSE_MS)
  if (block.consecutive429 >= BREAKER_THRESHOLD) {
    block.until = Date.now() + BREAKER_OPEN_MS
    block.ok = 0
    // Half-open afterwards: one more 429 re-opens it after a short pause.
    block.consecutive429 = BREAKER_THRESHOLD - 2
  }
}

function noteSuccess(kind: PageKind): void {
  consecutive429 = 0
  const block = blocks[kind]
  block.consecutive429 = 0
  block.streak = 0
  block.ok++
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

function throttledFetch(url: string, kind: PageKind): Promise<Response> {
  const run = queue.then(async () => {
    if (Date.now() < blocks[kind].until) {
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
  const kind = pageKind(url)
  let rateLimited = 0
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined
    try {
      res = await throttledFetch(url, kind)
    } catch (err) {
      if (err instanceof SourceRateLimitedError || attempt >= FETCH_RETRIES) throw err
    }
    if (res) {
      if (res.status === 429) {
        // Before the first await: callers already queued behind this request
        // must see the new pause/breaker when they start.
        const announced = retryAfterMs(res)
        const blockedFor = announced != null ? openBreakerFor(kind, announced) : null
        if (blockedFor == null) noteRateLimited(kind)
        await res.arrayBuffer().catch(() => {})
        if (blockedFor != null) {
          throw new SourceRateLimitedError(`alo.bg rate limit: HTTP 429, retry after ${Math.round(blockedFor / 60_000)} min`)
        }
        if (++rateLimited >= RATE_LIMIT_ATTEMPTS || Date.now() < blocks[kind].until) {
          throw new SourceRateLimitedError(`alo.bg rate limit: HTTP 429 after ${rateLimited} attempt(s)`)
        }
        continue
      }
      if (res.ok || res.status < 500) {
        if (res.ok) noteSuccess(kind)
        return res
      }
      if (attempt >= FETCH_RETRIES) return res
      await res.arrayBuffer().catch(() => {})
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
  }
}
