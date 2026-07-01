import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  checkRateLimit,
  recordFailedAttempt,
  resetRateLimit,
  signSession,
  timingSafePasswordEqual,
  verifySession,
} from './settings-auth'

const SECRET = 'x'.repeat(64)

describe('signSession / verifySession', () => {
  it('round-trips a cookie value', () => {
    const cookie = signSession(SECRET, 1_700_000_000_000)
    expect(cookie).toMatch(/^1700000000000\.[0-9a-f]{64}$/)
    expect(verifySession(SECRET, cookie, 1_699_000_000_000)).toBe(true)
  })

  it('rejects an expired cookie', () => {
    const cookie = signSession(SECRET, 1_700_000_000_000)
    expect(verifySession(SECRET, cookie, 1_700_000_000_001)).toBe(false)
  })

  it('rejects tampered expiry', () => {
    const cookie = signSession(SECRET, 1_700_000_000_000)
    const [, hmac] = cookie.split('.')
    const tampered = `1800000000000.${hmac}`
    expect(verifySession(SECRET, tampered, 1_700_000_000_000)).toBe(false)
  })

  it('rejects tampered hmac', () => {
    const cookie = signSession(SECRET, 1_700_000_000_000)
    const [expiry] = cookie.split('.')
    const tampered = `${expiry}.${'0'.repeat(64)}`
    expect(verifySession(SECRET, tampered, 1_700_000_000_000)).toBe(false)
  })

  it('rejects a malformed cookie', () => {
    expect(verifySession(SECRET, 'not-a-cookie', 0)).toBe(false)
    expect(verifySession(SECRET, '', 0)).toBe(false)
    expect(verifySession(SECRET, '1700.abc', 0)).toBe(false)
  })

  it('rejects when secret differs', () => {
    const cookie = signSession(SECRET, 1_700_000_000_000)
    expect(verifySession('y'.repeat(64), cookie, 1_699_000_000_000)).toBe(false)
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
})
