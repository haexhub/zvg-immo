import { afterEach, describe, expect, it, vi } from 'vitest'

const { getPool, sendMail } = vi.hoisted(() => ({ getPool: vi.fn(), sendMail: vi.fn() }))
vi.mock('./db', () => ({ getPool }))
vi.mock('./mailer', () => ({ sendMail }))

const { drainOutboundDeliveries, enqueueAlertDelivery } = await import('./outbound-delivery')

afterEach(() => vi.clearAllMocks())

describe('durable mail worker', () => {
  it('keeps an SMTP failure pending and later marks the same delivery sent', async () => {
    let canClaim = true
    let attempts = 1
    const updates: unknown[][] = []
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('WITH candidate')) {
          if (!canClaim) return { rows: [] }
          canClaim = false
          return { rows: [{
            id: 'delivery-1', kind: 'lawyer_inquiry', attempts,
            payload: { inquiryId: 'inquiry-1', to: 'lawyer@example.test', subject: 'Test', text: 'Hello' },
          }] }
        }
        updates.push(params)
        return { rows: [] }
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          updates.push([sql, ...params])
          return { rows: [] }
        }),
        release: vi.fn(),
      })),
    }
    getPool.mockReturnValue(pool)
    sendMail.mockRejectedValueOnce(new Error('SMTP 421 temporary outage')).mockResolvedValueOnce(undefined)

    await expect(drainOutboundDeliveries(1)).resolves.toEqual({ sent: 0, failed: 1 })
    expect(updates.some((params) => params.includes('pending'))).toBe(true)

    canClaim = true
    attempts = 2
    await expect(drainOutboundDeliveries(1)).resolves.toEqual({ sent: 1, failed: 0 })
    expect(sendMail).toHaveBeenCalledTimes(2)
    expect(updates.some((params) => params[0] === 'UPDATE outbound_deliveries SET status = \'sent\', sent_at = now(), locked_at = NULL, last_error_class = NULL\n       WHERE id = $1')).toBe(true)
  })

  it('marks a terminally failed lawyer inquiry delivery atomically, in the same transaction as the outbox row', async () => {
    const clientQueries: unknown[][] = []
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('WITH candidate')) {
          return { rows: [{
            id: 'delivery-1', kind: 'lawyer_inquiry', attempts: 6,
            payload: { inquiryId: 'inquiry-1', to: 'lawyer@example.test', subject: 'Test', text: 'Hello' },
          }] }
        }
        if (sql.includes('WITH exhausted')) return { rows: [] }
        throw new Error('markDeliveryFailure must use a transactional client, not the bare pool')
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          clientQueries.push([sql, ...params])
          return { rows: [] }
        }),
        release: vi.fn(),
      })),
    }
    getPool.mockReturnValue(pool)
    sendMail.mockRejectedValueOnce(new Error('SMTP 550 rejected'))

    await expect(drainOutboundDeliveries(1)).resolves.toEqual({ sent: 0, failed: 1 })

    expect(clientQueries[0]).toEqual(['BEGIN'])
    expect(clientQueries.at(-1)).toEqual(['COMMIT'])
    expect(clientQueries.some((q) => String(q[0]).includes('UPDATE outbound_deliveries') && q.includes('failed'))).toBe(true)
    expect(clientQueries.some((q) => String(q[0]).includes('UPDATE lawyer_inquiries') && String(q[0]).includes("'failed'"))).toBe(true)
  })
  it('ends exhausted stale leases as failed and only reclaims leases with attempts left', async () => {
    const poolQueries: unknown[][] = []
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        poolQueries.push([sql, ...params])
        return { rows: [] }
      }),
      connect: vi.fn(),
    }
    getPool.mockReturnValue(pool)

    await expect(drainOutboundDeliveries(1)).resolves.toEqual({ sent: 0, failed: 0 })

    const [exhaust, claim] = poolQueries
    expect(String(exhaust![0])).toContain("status = 'failed'")
    expect(String(exhaust![0])).toContain('attempts >= $1')
    expect(String(exhaust![0])).toContain('UPDATE lawyer_inquiries')
    expect(exhaust![1]).toBe(6)
    expect(String(claim![0])).toContain('attempts < $1')
    expect(claim![1]).toBe(6)
  })

  it('fails a malformed row and keeps draining the deliveries behind it', async () => {
    const claims = [
      { id: 'poison', kind: 'bogus', attempts: 1, payload: null },
      { id: 'delivery-2', kind: 'lawyer_inquiry', attempts: 1, payload: { inquiryId: 'inquiry-2', to: 'lawyer@example.test', subject: 'Test', text: 'Hello' } },
    ]
    const poolQueries: unknown[][] = []
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('WITH candidate')) return { rows: claims.splice(0, 1) }
        poolQueries.push([sql, ...params])
        return { rows: [] }
      }),
      connect: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })),
    }
    getPool.mockReturnValue(pool)
    sendMail.mockResolvedValueOnce(undefined)

    await expect(drainOutboundDeliveries(5)).resolves.toEqual({ sent: 1, failed: 1 })
    expect(poolQueries.some((q) => String(q[0]).includes("'invalid_payload'") && q[1] === 'poison')).toBe(true)
    expect(sendMail).toHaveBeenCalledOnce()
  })
  it('confirms a sent alert in notified_matches inside the same transaction as the outbox row', async () => {
    const clientQueries: unknown[][] = []
    let claimed = false
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('WITH candidate') && !claimed) {
          claimed = true
          return { rows: [{
            id: 'delivery-1', kind: 'alert', attempts: 1,
            payload: { alertSubscriptionId: 'sub-1', platform: 'portal', externalId: '42', to: 'buyer@example.test', subject: 'Treffer', text: 'Hello' },
          }] }
        }
        if (sql.includes('FROM alert_subscriptions')) return { rows: [{ '?column?': 1 }] }
        return { rows: [] }
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          clientQueries.push([sql, ...params])
          return { rows: [] }
        }),
        release: vi.fn(),
      })),
    }
    getPool.mockReturnValue(pool)
    sendMail.mockResolvedValueOnce(undefined)

    await expect(drainOutboundDeliveries(1)).resolves.toEqual({ sent: 1, failed: 0 })

    expect(clientQueries[0]).toEqual(['BEGIN'])
    expect(clientQueries.at(-1)).toEqual(['COMMIT'])
    expect(clientQueries.some((q) => String(q[0]).includes("SET status = 'sent'"))).toBe(true)
    expect(clientQueries).toContainEqual([expect.stringContaining('INSERT INTO notified_matches'), 'sub-1', 'portal', '42'])
    // Guarded, so a subscription deleted mid-send cannot roll back the 'sent' mark.
    expect(clientQueries.find((q) => String(q[0]).includes('INSERT INTO notified_matches'))?.[0]).toContain('WHERE EXISTS')
  })

  it('does not send an alert whose subscription was deleted or disabled after it was queued', async () => {
    const poolQueries: unknown[][] = []
    let claimed = false
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('WITH candidate') && !claimed) {
          claimed = true
          return { rows: [{
            id: 'delivery-1', kind: 'alert', attempts: 1,
            payload: { alertSubscriptionId: 'sub-gone', platform: 'portal', externalId: '42', to: 'buyer@example.test', subject: 'Treffer', text: 'Hello' },
          }] }
        }
        poolQueries.push([sql, ...params])
        return { rows: [] }
      }),
      connect: vi.fn(),
    }
    getPool.mockReturnValue(pool)

    await expect(drainOutboundDeliveries(1)).resolves.toEqual({ sent: 0, failed: 1 })

    expect(sendMail).not.toHaveBeenCalled()
    expect(poolQueries.some((q) => String(q[0]).includes("'subscription_inactive'") && q[1] === 'delivery-1')).toBe(true)
  })

  it('enqueues one alert per subscription and auction via the dedupe key', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) }
    getPool.mockReturnValue(pool)
    const payload = { alertSubscriptionId: 'sub-1', platform: 'portal', externalId: '42', to: 'buyer@example.test', subject: 'Treffer', text: 'Hello' }

    await expect(enqueueAlertDelivery(payload)).resolves.toBe(true)

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (dedupe_key) DO NOTHING'),
      ['alert:sub-1:portal:42', JSON.stringify(payload)],
    )
  })
})
