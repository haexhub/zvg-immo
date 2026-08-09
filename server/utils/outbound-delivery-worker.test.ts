import { afterEach, describe, expect, it, vi } from 'vitest'

const { getPool, sendMail } = vi.hoisted(() => ({ getPool: vi.fn(), sendMail: vi.fn() }))
vi.mock('./db', () => ({ getPool }))
vi.mock('./mailer', () => ({ sendMail }))

const { drainOutboundDeliveries } = await import('./outbound-delivery')

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
})
