import { afterEach, describe, expect, it, vi } from 'vitest'

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }))
vi.mock('./db', () => ({ getPool }))

const {
  createLawyerInquiryWithDelivery, findLawyerInquiryReplay, LawyerInquiryIdempotencyConflictError, LawyerInquiryRateLimitError,
} = await import('./outbound-delivery')

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

  it('refuses to replay a key that was reused for a different lawyer or message', async () => {
    const pool = poolWith(async (sql) => ({ rows: sql.includes('FROM lawyer_inquiries WHERE user_id') ? [row] : [] }))
    getPool.mockReturnValue(pool)

    await expect(createLawyerInquiryWithDelivery({ ...input, lawyerId: 'lawyer-2' })).rejects.toBeInstanceOf(LawyerInquiryIdempotencyConflictError)
    expect(pool.client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(pool.client.query).not.toHaveBeenCalledWith('COMMIT')

    const replayPool = { query: vi.fn(async () => ({ rows: [row] })) }
    getPool.mockReturnValue(replayPool)
    await expect(findLawyerInquiryReplay(input)).resolves.toMatchObject({ id: 'inquiry-1' })
    await expect(findLawyerInquiryReplay({ ...input, message: 'Changed' })).rejects.toBeInstanceOf(LawyerInquiryIdempotencyConflictError)
  })
})

describe('lawyer inquiry persistence', () => {
  function freshInquiryPool(outboxInsert: () => Promise<{ rows: Record<string, unknown>[] }> = async () => ({ rows: [] })) {
    return poolWith(async (sql) => {
      if (sql.includes('count(*)')) return { rows: [{ count: '0' }] }
      if (sql.includes('INSERT INTO lawyer_inquiries')) return { rows: [row] }
      if (sql.includes('INSERT INTO outbound_deliveries')) return outboxInsert()
      return { rows: [] }
    })
  }

  it('stores the inquiry and exactly one outbox row inside one transaction', async () => {
    const pool = freshInquiryPool()
    getPool.mockReturnValue(pool)

    await expect(createLawyerInquiryWithDelivery(input)).resolves.toMatchObject({ id: 'inquiry-1' })

    const statements = pool.client.query.mock.calls.map(([sql]) => sql)
    const begin = statements.indexOf('BEGIN')
    const inquiryInsert = statements.findIndex((sql) => sql.includes('INSERT INTO lawyer_inquiries'))
    const outboxInserts = statements.flatMap((sql, i) => (sql.includes('INSERT INTO outbound_deliveries') ? [i] : []))
    const commit = statements.indexOf('COMMIT')
    expect(outboxInserts).toHaveLength(1)
    expect(begin).toBeLessThan(inquiryInsert)
    expect(inquiryInsert).toBeLessThan(outboxInserts[0]!)
    expect(outboxInserts[0]).toBeLessThan(commit)
    const outboxCall = pool.client.query.mock.calls[outboxInserts[0]!] as unknown as [string, unknown[]]
    expect(outboxCall[1]).toEqual(['lawyer-inquiry:inquiry-1', JSON.stringify({ ...input.mail, inquiryId: 'inquiry-1' })])
    expect(pool.client.release).toHaveBeenCalledOnce()
  })

  it('rolls the inquiry back when its outbox row cannot be written', async () => {
    const pool = freshInquiryPool(async () => { throw new Error('outbox insert failed') })
    getPool.mockReturnValue(pool)

    await expect(createLawyerInquiryWithDelivery(input)).rejects.toThrow('outbox insert failed')
    expect(pool.client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(pool.client.query).not.toHaveBeenCalledWith('COMMIT')
    expect(pool.client.release).toHaveBeenCalledOnce()
  })
})
