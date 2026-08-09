import { afterEach, describe, expect, it, vi } from 'vitest'

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }))
vi.mock('./db', () => ({ getPool }))

const { createLawyerInquiryWithDelivery, LawyerInquiryRateLimitError } = await import('./outbound-delivery')

const row = {
  id: 'inquiry-1', lawyer_id: 'lawyer-1', platform: 'portal', external_id: '42', message: 'Hello',
  commission_cents: 12900, commission_status: 'pending', delivery_status: 'pending', created_at: new Date('2026-08-09T10:00:00.000Z'),
}
const input = {
  userId: 'user-1', lawyerId: 'lawyer-1', platform: 'portal', externalId: '42', message: 'Hello', commissionCents: 12900,
  idempotencyKey: '88a2d4ea-cda7-4384-9a0e-443811f33a7d',
  mail: { to: 'lawyer@example.test', subject: 'Test', text: 'Hello' },
}

function poolWith(query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>) {
  const client = { query: vi.fn(query), release: vi.fn() }
  return { connect: vi.fn(async () => client), client }
}

afterEach(() => vi.clearAllMocks())

describe('lawyer inquiry idempotency and rate limit', () => {
  it('returns the original billable row on an ambiguous client retry without a second outbox row', async () => {
    const pool = poolWith(async (sql) => ({ rows: sql.includes('FROM lawyer_inquiries WHERE user_id') ? [row] : [] }))
    getPool.mockReturnValue(pool)

    await expect(createLawyerInquiryWithDelivery(input)).resolves.toMatchObject({ id: 'inquiry-1', deliveryStatus: 'pending' })
    expect(pool.client.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO lawyer_inquiries'), expect.anything())
    expect(pool.client.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO outbound_deliveries'), expect.anything())
  })

  it('also converges concurrent retries that were waiting on the rate-limit lock', async () => {
    let idempotencyReads = 0
    const pool = poolWith(async (sql) => {
      if (sql.includes('FROM lawyer_inquiries WHERE user_id')) {
        idempotencyReads++
        return { rows: idempotencyReads === 2 ? [row] : [] }
      }
      return { rows: [] }
    })
    getPool.mockReturnValue(pool)

    await expect(createLawyerInquiryWithDelivery(input)).resolves.toMatchObject({ id: 'inquiry-1' })
    expect(pool.client.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO lawyer_inquiries'), expect.anything())
  })

  it('rejects a sixth user-to-lawyer request before a lead or delivery is created', async () => {
    const pool = poolWith(async (sql) => ({ rows: sql.includes('count(*)') ? [{ count: '5' }] : [] }))
    getPool.mockReturnValue(pool)

    await expect(createLawyerInquiryWithDelivery(input)).rejects.toBeInstanceOf(LawyerInquiryRateLimitError)
    expect(pool.client.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO lawyer_inquiries'), expect.anything())
  })
})
