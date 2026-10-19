import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CURRENT_AUCTION_CONDITIONS } from './current-auction-sql'

// Real-Postgres suite, skipped without TEST_DATABASE_URL (migrations applied),
// like current-auctions.test.ts. Scoped to its own country so it can run next
// to the other real-DB suites.
const TEST_DB = process.env.TEST_DATABASE_URL
const describeDb = TEST_DB ? describe : describe.skip
const COUNTRY = 'zz-current-auction-sql-test'

describeDb('CURRENT_AUCTION_CONDITIONS (real Postgres)', () => {
  let pool: import('pg').Pool

  beforeAll(async () => {
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: TEST_DB })
  })

  afterAll(async () => {
    await pool.query('DELETE FROM auctions WHERE country = $1', [COUNTRY])
    await pool.query('DELETE FROM crawl_state WHERE country = $1', [COUNTRY])
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM auctions WHERE country = $1', [COUNTRY])
    await pool.query('DELETE FROM crawl_state WHERE country = $1', [COUNTRY])
  })

  async function insertAuction(externalId: string, fields: { crawlRegion: string | null; lastSeenAt: string | null; firstSeenAt?: string }) {
    await pool.query(
      `INSERT INTO auctions (platform, external_id, country, region, authority, case_number, cancelled, crawl_region, last_seen_at, first_seen_at)
       VALUES ('dga-ag', $1, $2, 'Brandenburg', 'DIIA', '', false, $3, $4, $5)`,
      [externalId, COUNTRY, fields.crawlRegion, fields.lastSeenAt, fields.firstSeenAt ?? '2026-08-19T14:00:00Z'],
    )
  }

  async function crawled(region: string, at: string) {
    await pool.query(
      `INSERT INTO crawl_state (country, region, platform, last_success_at) VALUES ($1, $2, 'dga-ag', $3)`,
      [COUNTRY, region, at],
    )
  }

  async function currentIds(): Promise<string[]> {
    const { rows } = await pool.query<{ external_id: string }>(
      `SELECT a.external_id FROM auctions a WHERE a.country = $1 AND ${CURRENT_AUCTION_CONDITIONS.join(' AND ')} ORDER BY a.external_id`,
      [COUNTRY],
    )
    return rows.map((row) => row.external_id)
  }

  it('expires an unstamped listing once every scope of its platform completed after it was last seen', async () => {
    await insertAuction('ghost', { crawlRegion: null, lastSeenAt: '2026-08-19T20:00:00Z' })
    await crawled('bb', '2026-10-19T12:00:00Z')
    await crawled('st', '2026-10-19T12:05:00Z')

    expect(await currentIds()).toEqual([])
  })

  it('keeps an unstamped listing while one scope of its platform has not completed since', async () => {
    await insertAuction('maybe', { crawlRegion: null, lastSeenAt: '2026-08-19T20:00:00Z' })
    await crawled('bb', '2026-10-19T12:00:00Z')
    await crawled('st', '2026-08-01T00:00:00Z')

    expect(await currentIds()).toEqual(['maybe'])
  })

  it('keeps an unstamped listing when its platform has no crawl_state yet', async () => {
    await insertAuction('fresh', { crawlRegion: null, lastSeenAt: null })

    expect(await currentIds()).toEqual(['fresh'])
  })

  it('falls back to first_seen_at for a row created before any crawl stamped it', async () => {
    await insertAuction('created-by-geocode', { crawlRegion: null, lastSeenAt: null, firstSeenAt: '2026-08-19T14:00:00Z' })
    await insertAuction('created-after', { crawlRegion: null, lastSeenAt: null, firstSeenAt: '2026-10-19T13:00:00Z' })
    await crawled('bb', '2026-10-19T12:00:00Z')

    expect(await currentIds()).toEqual(['created-after'])
  })

  it('still expires a stamped listing only through its own scope', async () => {
    await insertAuction('gone', { crawlRegion: 'bb', lastSeenAt: '2026-10-18T12:00:00Z' })
    await insertAuction('elsewhere', { crawlRegion: 'st', lastSeenAt: '2026-10-18T12:00:00Z' })
    await crawled('bb', '2026-10-19T12:00:00Z')

    expect(await currentIds()).toEqual(['elsewhere'])
  })
})
