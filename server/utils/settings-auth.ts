// Password + HMAC-cookie auth for the /settings page. Solo-deployment scope —
// no user database, no OAuth. Session state lives in a signed cookie; the
// only server-side state is one session epoch in app_settings, which logout
// rotates to revoke every cookie issued before it.

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Pool } from 'pg'
import { readSetting, writeSetting } from './app-settings-store'
import { getPool } from './db'

// Absolute session lifetime from login. The middleware's sliding refresh
// carries the original issue time forward, so a stolen cookie cannot be kept
// alive indefinitely by replaying it at least once every 24h.
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Derive the cookie signing key from the session secret, the admin password
 * and the session epoch, so changing NUXT_SETTINGS_PASSWORD or logging out
 * revokes every issued session (not only rotating the secret).
 */
export function sessionSigningKey(secret: string, password: string, epoch: string): string {
  return createHmac('sha256', secret).update(password, 'utf8').update('\0').update(epoch, 'utf8').digest('hex')
}

const SESSION_EPOCH_KEY = 'settings_session_epoch'
// The middleware runs on every /api/settings/* request, so the epoch is read
// through a short cache. The instance that handles a logout updates its cache
// at once; ponytail: another instance keeps accepting the old cookie for up to
// EPOCH_CACHE_MS — push the rotation (LISTEN/NOTIFY) if this ever runs on
// more than one replica.
const EPOCH_CACHE_MS = 5_000
let epochCache: { value: string; readAt: number } | null = null

/** '' when nothing is stored yet or Postgres is not configured — logout then
 *  only clears the client cookie, as there is nowhere to record a rotation. */
export async function readSessionEpoch(db: Pool | null, now: number): Promise<string> {
  if (!db) return ''
  if (epochCache && now - epochCache.readAt < EPOCH_CACHE_MS) return epochCache.value
  const row = await readSetting(db, SESSION_EPOCH_KEY)
  const value = typeof row?.value === 'string' ? row.value : ''
  epochCache = { value, readAt: now }
  return value
}

export async function rotateSessionEpoch(db: Pool, now: number): Promise<void> {
  const value = randomUUID()
  await writeSetting(db, SESSION_EPOCH_KEY, value)
  epochCache = { value, readAt: now }
}

export function resetSessionEpochCache(): void {
  epochCache = null
}

/** The signing key for cookies issued and verified right now. */
export async function currentSessionSigningKey(secret: string, password: string, now: number): Promise<string> {
  return sessionSigningKey(secret, password, await readSessionEpoch(getPool(), now))
}

/**
 * Build the session cookie value. Format:
 * `<issued-at-unix-ms>.<expiry-unix-ms>.<hmac-sha256>`. `verifySession`
 * re-derives the HMAC from both timestamps and compares byte-safe.
 */
export function signSession(key: string, issuedAtUnixMs: number, expiryUnixMs: number): string {
  const payload = `${issuedAtUnixMs}.${expiryUnixMs}`
  const hmac = createHmac('sha256', key).update(payload).digest('hex')
  return `${payload}.${hmac}`
}

/**
 * Verify a cookie value against `now` and return its issue time, or null.
 * Rejects on malformed input, expired timestamp, a session older than
 * SESSION_MAX_AGE_MS, tampered timestamps, or wrong HMAC. Timing-safe HMAC
 * comparison.
 */
export function verifySession(key: string, cookie: string, now: number): number | null {
  const match = /^(\d+)\.(\d+)\.([0-9a-f]{64})$/.exec(cookie)
  if (!match) return null
  const issuedAt = match[1]!
  const expiry = match[2]!
  const hmac = match[3]!
  const issuedAtMs = Number(issuedAt)
  const expiryMs = Number(expiry)
  if (!Number.isSafeInteger(issuedAtMs) || !Number.isSafeInteger(expiryMs)) return null
  if (expiryMs <= now || now - issuedAtMs >= SESSION_MAX_AGE_MS) return null
  const expected = createHmac('sha256', key).update(`${issuedAt}.${expiry}`).digest()
  const actual = Buffer.from(hmac, 'hex')
  if (expected.length !== actual.length) return null
  return timingSafeEqual(expected, actual) ? issuedAtMs : null
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
