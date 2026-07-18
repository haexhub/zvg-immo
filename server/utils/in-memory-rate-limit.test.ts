import { describe, expect, it } from 'vitest'
import {
  checkInMemoryRateLimit,
  createInMemoryRateLimitState,
  recordInMemoryRateLimitHit,
} from './in-memory-rate-limit'

describe('in-memory rate limit', () => {
  it('blocks after max hits inside the rolling window', () => {
    const state = createInMemoryRateLimitState()
    const opts = { max: 2, windowMs: 1_000 }

    expect(checkInMemoryRateLimit(state, 'ip', 100, opts)).toBe(true)
    recordInMemoryRateLimitHit(state, 'ip', 100, opts)
    expect(checkInMemoryRateLimit(state, 'ip', 200, opts)).toBe(true)
    recordInMemoryRateLimitHit(state, 'ip', 200, opts)
    expect(checkInMemoryRateLimit(state, 'ip', 300, opts)).toBe(false)
  })

  it('forgets expired hits', () => {
    const state = createInMemoryRateLimitState()
    const opts = { max: 1, windowMs: 1_000 }

    recordInMemoryRateLimitHit(state, 'ip', 100, opts)
    expect(checkInMemoryRateLimit(state, 'ip', 1_101, opts)).toBe(true)
  })

  it('caps key growth', () => {
    const state = createInMemoryRateLimitState()
    const opts = { max: 5, windowMs: 1_000, maxKeys: 2 }

    recordInMemoryRateLimitHit(state, 'a', 100, opts)
    recordInMemoryRateLimitHit(state, 'b', 100, opts)
    recordInMemoryRateLimitHit(state, 'c', 100, opts)

    expect(state.attempts.size).toBe(2)
    expect(state.attempts.has('a')).toBe(false)
  })
})
