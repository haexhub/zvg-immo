import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auction } from '~/types/auction'

// Real-Postgres suite, skipped without TEST_DATABASE_URL (migrations applied),
// like current-auction-sql.test.ts. Scoped to its own platform so it can run
// next to the other real-DB suites.
const TEST_DB = process.env.TEST_DATABASE_URL
const describeDb = TEST_DB ? describe : describe.skip
const PLATFORM = 'zz-history-observations-test'

const db = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }))
vi.mock('./db', () => ({ getPool: () => db.pool }))

function auction(externalId: string, overrides: Partial<Auction> = {}): Auction {
  return {
    platform: PLATFORM,
    country: 'zz',
    region: 'Test',
    externalId,
    caseNumber: '1 K 1/26',
    authority: 'AG Test',
    title: 'Einfamilienhaus',
    address: null,
    marketValueEur: 250000,
    marketValueText: null,
    auctionDateIso: '2026-08-01T09:00:00.000Z',
    auctionDateText: null,
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    description: null,
    photoCount: 0,
    thumbnailUrl: null,
    ...overrides,
  }
}

describeDb('recordObservations (real Postgres)', () => {
  beforeAll(async () => {
    const { Pool } = await import('pg')
    db.pool = new Pool({ connectionString: TEST_DB })
  })

  afterAll(async () => {
    await clear()
    await db.pool!.end()
  })

  beforeEach(clear)

  async function clear() {
    await db.pool!.query('DELETE FROM auction_observations WHERE platform = $1', [PLATFORM])
    await db.pool!.query('DELETE FROM auction_observation_heads WHERE platform = $1', [PLATFORM])
  }

  async function observations(): Promise<Array<{ external_id: string; captured_at: Date; cancelled: boolean }>> {
    const { rows } = await db.pool!.query(
      `SELECT external_id, captured_at, cancelled FROM auction_observations
        WHERE platform = $1 ORDER BY captured_at, external_id`,
      [PLATFORM],
    )
    return rows
  }

  it('writes a run only for the auctions whose payload changed', async () => {
    const { recordObservations } = await import('./history')
    const run = (auctions: Auction[], at: string, kind: 'list' | 'detail') =>
      recordObservations({ auctions, errors: [] } as never, at, kind)

    await run([auction('a'), auction('b')], '2026-10-21T10:00:00.000Z', 'list')
    await run([auction('a'), auction('b', { cancelled: true })], '2026-10-21T11:00:00.000Z', 'list')
    // The first detail row of an auction is written even though its list twin
    // carries the same payload: heads are kept per kind.
    await run([auction('a', { detailFetchedAt: '2026-10-21T12:00:00.000Z' })], '2026-10-21T12:00:00.000Z', 'detail')
    await run([auction('a', { detailFetchedAt: '2026-10-21T18:00:00.000Z' })], '2026-10-21T18:00:00.000Z', 'detail')
    await run([auction('a', { detailFetchedAt: '2026-10-22T12:00:00.000Z' })], '2026-10-22T12:00:00.000Z', 'detail')

    expect((await observations()).map((row) => [row.external_id, row.captured_at.toISOString(), row.cancelled])).toEqual([
      ['a', '2026-10-21T10:00:00.000Z', false],
      ['b', '2026-10-21T10:00:00.000Z', false],
      ['b', '2026-10-21T11:00:00.000Z', true],
      ['a', '2026-10-21T12:00:00.000Z', false],
      ['a', '2026-10-22T12:00:00.000Z', false],
    ])
  })
})
