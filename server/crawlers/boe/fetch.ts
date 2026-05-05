import { UA } from './constants'

const FETCH_TIMEOUT_MS = 15_000
// BOE serves a CAPTCHA after a burst of requests from one IP. Module-level
// minimum gap keeps total BOE traffic to ~1 req per MIN_GAP_MS, regardless
// of how many concurrent crawlAll workers / detail fetches race for the
// upstream. Detail enrichment uses Promise.all internally for ver=1+ver=3
// pairs; both still serialise through this gap.
const MIN_GAP_MS = 800
let lastFetchAt = 0
let queue: Promise<void> = Promise.resolve()

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
export async function boeFetch(url: string): Promise<string> {
  await gate()
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
