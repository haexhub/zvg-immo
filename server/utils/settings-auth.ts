// Password + HMAC-cookie auth for the /settings page. Solo-deployment scope —
// no user database, no OAuth. Session state lives entirely in a signed cookie
// so nothing needs to survive across container restarts.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Build the session cookie value. Format: `<expiry-unix-ms>.<hmac-sha256>`.
 * `verifySession` re-derives the HMAC from the expiry and compares byte-safe.
 */
export function signSession(secret: string, expiryUnixMs: number): string {
  const expiry = String(expiryUnixMs)
  const hmac = createHmac('sha256', secret).update(expiry).digest('hex')
  return `${expiry}.${hmac}`
}

/**
 * Verify a cookie value against `now`. Rejects on malformed input, expired
 * timestamp, tampered expiry, or wrong HMAC. Timing-safe HMAC comparison.
 */
export function verifySession(secret: string, cookie: string, now: number): boolean {
  if (!cookie) return false
  const idx = cookie.indexOf('.')
  if (idx <= 0) return false
  const expiry = cookie.slice(0, idx)
  const hmac = cookie.slice(idx + 1)
  if (!/^\d+$/.test(expiry) || !/^[0-9a-f]{64}$/.test(hmac)) return false
  const expiryMs = Number(expiry)
  if (!Number.isFinite(expiryMs) || expiryMs <= now) return false
  const expected = createHmac('sha256', secret).update(expiry).digest()
  const actual = Buffer.from(hmac, 'hex')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/**
 * Timing-safe password compare. SHA-256 both inputs first so the actual
 * timingSafeEqual call always operates on fixed-length buffers — a
 * length-based short-circuit would leak the correct password's length via a
 * timing side channel.
 */
export function timingSafePasswordEqual(a: string, b: string): boolean {
  if (!a || !b) return false
  const digestA = createHash('sha256').update(a, 'utf8').digest()
  const digestB = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(digestA, digestB)
}

// In-memory rate limit for the /api/settings/login endpoint. Keyed by ip.
// 5 failed attempts in the last 60s → locked until the window rolls off.
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60_000
// Hard cap on distinct IP keys. Without this a hostile scanner rotating IPs
// could grow the map without bound. When the cap is hit, sweep expired
// entries first; if that doesn't free room, drop the oldest.
const RATE_LIMIT_MAX_KEYS = 10_000
const attempts = new Map<string, number[]>()

function prune(list: number[], now: number): number[] {
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  const out: number[] = []
  for (const t of list) if (t > cutoff) out.push(t)
  return out
}

/** Drop every entry whose most-recent hit is outside the window. */
function sweepExpired(now: number): void {
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  for (const [key, list] of attempts) {
    const latest = list[list.length - 1]
    if (latest === undefined || latest <= cutoff) attempts.delete(key)
  }
}

function ensureRoom(now: number): void {
  if (attempts.size < RATE_LIMIT_MAX_KEYS) return
  sweepExpired(now)
  if (attempts.size < RATE_LIMIT_MAX_KEYS) return
  // Still over the cap — drop the oldest inserted entry. Map iteration order
  // is insertion order in Node, so the first key is the oldest.
  const firstKey = attempts.keys().next().value
  if (firstKey !== undefined) attempts.delete(firstKey)
}

export function checkRateLimit(ip: string, now: number): boolean {
  const list = attempts.get(ip)
  if (!list) return true
  const fresh = prune(list, now)
  if (fresh.length === 0) {
    attempts.delete(ip)
    return true
  }
  if (fresh.length !== list.length) attempts.set(ip, fresh)
  return fresh.length < RATE_LIMIT_MAX
}

export function recordFailedAttempt(ip: string, now: number): void {
  ensureRoom(now)
  const list = attempts.get(ip) ?? []
  const fresh = prune(list, now)
  fresh.push(now)
  attempts.set(ip, fresh)
}

export function resetRateLimit(): void {
  attempts.clear()
}

/** Test-only: exposes the current map size so we can assert on sweep behavior. */
export function _rateLimitMapSize(): number {
  return attempts.size
}
