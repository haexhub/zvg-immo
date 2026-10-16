import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  _rateLimitMapSize,
  checkRateLimit,
  recordFailedAttempt,
  resetRateLimit,
  SESSION_MAX_AGE_MS,
  sessionSigningKey,
  signSession,
  timingSafePasswordEqual,
  verifySession,
} from './settings-auth'

const SECRET = 'x'.repeat(64)

describe('signSession / verifySession', () => {
  const ISSUED = 1_699_000_000_000
  const EXPIRY = 1_700_000_000_000

  it('round-trips a cookie value and returns the issue time', () => {
    const cookie = signSession(SECRET, ISSUED, EXPIRY)
    expect(cookie).toMatch(/^1699000000000\.1700000000000\.[0-9a-f]{64}$/)
    expect(verifySession(SECRET, cookie, ISSUED + 1)).toBe(ISSUED)
  })

  it('rejects an expired cookie', () => {
    const cookie = signSession(SECRET, ISSUED, EXPIRY)
    expect(verifySession(SECRET, cookie, EXPIRY + 1)).toBeNull()
  })

  it('rejects a session older than the absolute max age even if not expired', () => {
    const cookie = signSession(SECRET, ISSUED, ISSUED + SESSION_MAX_AGE_MS + 60_000)
    expect(verifySession(SECRET, cookie, ISSUED + SESSION_MAX_AGE_MS - 1)).toBe(ISSUED)
    expect(verifySession(SECRET, cookie, ISSUED + SESSION_MAX_AGE_MS)).toBeNull()
  })

  it('rejects tampered timestamps', () => {
    const cookie = signSession(SECRET, ISSUED, EXPIRY)
    const [, , hmac] = cookie.split('.')
    expect(verifySession(SECRET, `${ISSUED}.1800000000000.${hmac}`, ISSUED)).toBeNull()
    expect(verifySession(SECRET, `${ISSUED + 1000}.${EXPIRY}.${hmac}`, ISSUED + 1000)).toBeNull()
  })

  it('rejects tampered hmac', () => {
    const tampered = `${ISSUED}.${EXPIRY}.${'0'.repeat(64)}`
    expect(verifySession(SECRET, tampered, ISSUED)).toBeNull()
  })

  it('rejects a malformed or legacy two-part cookie', () => {
    expect(verifySession(SECRET, 'not-a-cookie', 0)).toBeNull()
    expect(verifySession(SECRET, '', 0)).toBeNull()
    expect(verifySession(SECRET, '1700.abc', 0)).toBeNull()
    expect(verifySession(SECRET, `${EXPIRY}.${'a'.repeat(64)}`, 0)).toBeNull()
  })

  it('rejects when the signing key differs', () => {
    const cookie = signSession(SECRET, ISSUED, EXPIRY)
    expect(verifySession('y'.repeat(64), cookie, ISSUED)).toBeNull()
  })

  it('revokes sessions when the session epoch changes', () => {
    const cookie = signSession(sessionSigningKey(SECRET, 'pw', 'epoch-1'), ISSUED, EXPIRY)
    expect(verifySession(sessionSigningKey(SECRET, 'pw', 'epoch-1'), cookie, ISSUED)).toBe(ISSUED)
    expect(verifySession(sessionSigningKey(SECRET, 'pw', 'epoch-2'), cookie, ISSUED)).toBeNull()
  })

  it('revokes sessions when the admin password changes', () => {
    const cookie = signSession(sessionSigningKey(SECRET, 'old-password', ''), ISSUED, EXPIRY)
    expect(verifySession(sessionSigningKey(SECRET, 'old-password', ''), cookie, ISSUED)).toBe(ISSUED)
    expect(verifySession(sessionSigningKey(SECRET, 'new-password', ''), cookie, ISSUED)).toBeNull()
  })
})

describe('timingSafePasswordEqual', () => {
  it('matches equal strings', () => {
    expect(timingSafePasswordEqual('hunter2', 'hunter2')).toBe(true)
  })

  it('rejects different strings', () => {
    expect(timingSafePasswordEqual('hunter2', 'hunter3')).toBe(false)
  })

  it('rejects strings of different length without throwing', () => {
    expect(timingSafePasswordEqual('short', 'longer-password')).toBe(false)
  })

  it('rejects empty inputs safely', () => {
    expect(timingSafePasswordEqual('', 'anything')).toBe(false)
    expect(timingSafePasswordEqual('anything', '')).toBe(false)
  })
})

describe('rate limit', () => {
  beforeEach(() => {
    resetRateLimit()
  })

  it('allows the first attempt', () => {
    expect(checkRateLimit('1.2.3.4', Date.now())).toBe(true)
  })

  it('locks after 5 failed attempts', () => {
    const ip = '1.2.3.4'
    const now = Date.now()
    for (let i = 0; i < 5; i++) recordFailedAttempt(ip, now)
    expect(checkRateLimit(ip, now)).toBe(false)
  })

  it('does not lock a different ip', () => {
    const now = Date.now()
    for (let i = 0; i < 5; i++) recordFailedAttempt('1.2.3.4', now)
    expect(checkRateLimit('5.6.7.8', now)).toBe(true)
  })

  it('lifts the lock after the window (60s)', () => {
    const ip = '1.2.3.4'
    const t0 = 1_700_000_000_000
    for (let i = 0; i < 5; i++) recordFailedAttempt(ip, t0)
    expect(checkRateLimit(ip, t0 + 59_000)).toBe(false)
    expect(checkRateLimit(ip, t0 + 61_000)).toBe(true)
  })

  it('reset() clears all counters', () => {
    const ip = '1.2.3.4'
    for (let i = 0; i < 5; i++) recordFailedAttempt(ip, Date.now())
    resetRateLimit()
    expect(checkRateLimit(ip, Date.now())).toBe(true)
  })

  it('removes stale keys when checkRateLimit finds the window empty', () => {
    const t0 = 1_700_000_000_000
    for (let i = 0; i < 3; i++) recordFailedAttempt('1.2.3.4', t0)
    expect(_rateLimitMapSize()).toBe(1)
    // Query past the window — the key should be dropped, freeing the slot.
    expect(checkRateLimit('1.2.3.4', t0 + 61_000)).toBe(true)
    expect(_rateLimitMapSize()).toBe(0)
  })
})
