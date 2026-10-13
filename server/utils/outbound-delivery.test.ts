import { describe, expect, it } from 'vitest'
import {
  classifyDeliveryError,
  deliveryRetryAt,
  MAX_LAWYER_INQUIRY_MESSAGE_LENGTH,
  validateIdempotencyKey,
} from './outbound-delivery'

describe('outbound delivery policy', () => {
  it('uses a bounded exponential retry and classifies only non-secret failure metadata', () => {
    const now = new Date('2026-08-09T10:00:00.000Z')
    expect(deliveryRetryAt(1, now).toISOString()).toBe('2026-08-09T10:01:00.000Z')
    expect(deliveryRetryAt(99, now).toISOString()).toBe('2026-08-09T11:00:00.000Z')
    expect(classifyDeliveryError(new Error('SMTP 550 user@example.test rejected'))).toBe('smtp_550')
    expect(classifyDeliveryError(Object.assign(new Error('Message failed'), { responseCode: 554 }))).toBe('smtp_554')
    expect(classifyDeliveryError(new Error('connect ECONNREFUSED 10.0.0.1:465'))).toBe('network')
    expect(classifyDeliveryError(new Error('connect EHOSTUNREACH 10.0.0.1:587'))).toBe('network')
  })

  it('accepts a stable UUID idempotency key and rejects malformed or oversized keys', () => {
    expect(validateIdempotencyKey('88a2d4ea-cda7-4384-9a0e-443811f33a7d')).toBe(true)
    expect(validateIdempotencyKey('retry-me')).toBe(false)
    expect(validateIdempotencyKey('x'.repeat(129))).toBe(false)
  })

  it('sets a finite, server-side message limit', () => {
    expect(MAX_LAWYER_INQUIRY_MESSAGE_LENGTH).toBeGreaterThan(0)
  })
})
