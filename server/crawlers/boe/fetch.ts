import { UA } from './constants'

const FETCH_TIMEOUT_MS = 15_000
// BOE serves a CAPTCHA after a burst of requests from one IP. Module-level
// minimum gap keeps total BOE traffic to ~1 req per MIN_GAP_MS, regardless
// of how many concurrent crawlAll workers / detail fetches race for the
// upstream. Detail enrichment uses Promise.all internally for ver=1+ver=3
// pairs; both still serialise through this gap.
//
// 1500 ms (~40 req/min) was chosen empirically — 800 ms still tripped the
// captcha when a user filtered to a province with ~80 auctions and the
// detail-enrichment loop fired ~160 requests back-to-back.
const MIN_GAP_MS = 1500
let lastFetchAt = 0
let queue: Promise<void> = Promise.resolve()

// Once BOE shows a captcha, the IP is on a cooldown that lasts much longer
// than our gate. Continuing to hit them just extends the ban. After the
// first captcha we skip all BOE requests for COOLDOWN_MS so the upstream
// can forgive us — the user-facing API surfaces the same "captcha" message
// and falls through to the empty-result graceful path in auctions.get.ts.
const CAPTCHA_COOLDOWN_MS = 30 * 60 * 1000
let captchaCooldownUntil = 0

export function markBoeCaptcha(): void {
  captchaCooldownUntil = Date.now() + CAPTCHA_COOLDOWN_MS
}

function gate(): Promise<void> {
  // Chain each acquire onto the previous one so we get strict serial
  // execution of the wait-then-stamp dance, even with many concurrent
  // callers awaiting `gate()` simultaneously.
  const prev = queue
  let release!: () => void
  queue = new Promise<void>((resolve) => {
    release = resolve
  })
  return prev.then(async () => {
    const now = Date.now()
    const wait = Math.max(0, lastFetchAt + MIN_GAP_MS - now)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastFetchAt = Date.now()
    release()
  })
}

/**
 * Issues a rate-limited GET against subastas.boe.es with a 15s deadline and
 * the standard browser-ish headers BOE expects. The caller may inspect the
 * returned HTML for CAPTCHA markers — `fetchListHtml` and `detail.ts` do.
 */
function ensureNoCooldown(): void {
  if (Date.now() < captchaCooldownUntil) {
    const remainSec = Math.ceil((captchaCooldownUntil - Date.now()) / 1000)
    throw new Error(`BOE in CAPTCHA cooldown for ${remainSec}s`)
  }
}

export async function boeFetch(url: string): Promise<string> {
  // Two checks: pre-gate fast-path so callers fail before queuing, and
  // post-gate re-check because another in-flight worker may have marked
  // captcha while we were waiting on the rate gate. Without the second
  // check, queued callers would still hit BOE and extend the ban.
  ensureNoCooldown()
  await gate()
  ensureNoCooldown()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.5',
      },
    })
    if (!res.ok) throw new Error(`BOE ${res.status} for ${url}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

export function looksLikeCaptcha(html: string): boolean {
  return html.includes('cajaCaptcha') || html.includes('showCaptcha.php')
}
