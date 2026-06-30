import { UA } from './constants'
import { readBoeState, writeBoeState, type BoeState } from '../../utils/boe-state'

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

// Once BOE shows a captcha, the IP is on a ban that can last hours to days.
// We persist the cooldown to disk so a container restart doesn't reset it —
// previously every restart sent one BOE request, got captcha, and re-armed a
// fresh local cooldown, indefinitely extending the upstream ban.
//
// 24 h is conservative: BOE doesn't publish recovery windows, and shorter
// cooldowns just keep pinging a poisoned IP. Once we're cooled off and BOE
// forgives us, the next scheduled crawl succeeds and life goes on.
const CAPTCHA_COOLDOWN_MS = 24 * 60 * 60 * 1000

// Hard kill switch read from the container env. When BOE has banned the IP
// for an extended period, set BOE_DISABLED=1 in the deployment env and no
// `boeFetch` ever leaves the server. The crawler returns 0 auctions per
// provincia; the rest of the platforms keep working. Unset / `0` / `false`
// keep the crawler enabled.
function envFlag(name: string): boolean {
  const v = process.env[name]
  if (v == null) return false
  const s = v.trim().toLowerCase()
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no'
}
export function isBoeDisabled(): boolean {
  return envFlag('BOE_DISABLED')
}

// Module-level mirror of the on-disk state — hydrated lazily on first
// boeFetch so module-import time stays synchronous.
let state: BoeState = { captchaCooldownUntil: 0, lastCaptchaAt: null }
let hydratePromise: Promise<void> | null = null
function hydrate(): Promise<void> {
  if (!hydratePromise) {
    hydratePromise = (async () => {
      try {
        state = await readBoeState()
      } catch (err) {
        // Don't cache the failure — once someone fixes / removes the broken
        // boe-state.json on disk, the next caller should re-attempt instead
        // of needing a process restart.
        hydratePromise = null
        throw err
      }
    })()
  }
  return hydratePromise
}

export async function markBoeCaptcha(): Promise<void> {
  const now = Date.now()
  state = { captchaCooldownUntil: now + CAPTCHA_COOLDOWN_MS, lastCaptchaAt: now }
  try {
    await writeBoeState(state)
  } catch (err) {
    // Persisting the cooldown is best-effort — the in-memory cooldown still
    // protects this process even if disk writes fail (read-only volume,
    // disk full, etc). Log so it's noticed.
    console.warn('[boe] failed to persist cooldown state:', (err as Error).message)
  }
}

export async function getBoeState(): Promise<BoeState & { lastFetchAt: number }> {
  await hydrate()
  return { ...state, lastFetchAt }
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

function ensureNotDisabled(): void {
  if (isBoeDisabled()) {
    throw new Error('BOE crawler disabled via BOE_DISABLED env')
  }
}

function ensureNoCooldown(): void {
  if (Date.now() < state.captchaCooldownUntil) {
    const remainSec = Math.ceil((state.captchaCooldownUntil - Date.now()) / 1000)
    throw new Error(`BOE in CAPTCHA cooldown for ${remainSec}s`)
  }
}

/**
 * Issues a rate-limited GET against subastas.boe.es with a 15s deadline and
 * the standard browser-ish headers BOE expects. The caller may inspect the
 * returned HTML for CAPTCHA markers — `fetchListHtml` and `detail.ts` do.
 */
export async function boeFetch(url: string): Promise<string> {
  ensureNotDisabled()
  await hydrate()
  // Two checks: pre-gate fast-path so callers fail before queuing, and
  // post-gate re-check because another in-flight worker may have marked
  // captcha while we were waiting on the rate gate. Without the second
  // check, queued callers would still hit BOE and extend the ban.
  ensureNoCooldown()
  await gate()
  ensureNotDisabled()
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
