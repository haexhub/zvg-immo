import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./db', () => ({ getPool: vi.fn() }))
vi.mock('./auction-record', () => ({ readAuctionRecords: vi.fn() }))
vi.mock('./crawl-status', () => ({ readCrawlStatusByCountry: vi.fn() }))
vi.mock('./llm-status', () => ({ classifyLlmStatus: vi.fn(), isLlmExtractionInScope: vi.fn() }))
vi.mock('./osm-status', () => ({ readOsmStatusByCountry: vi.fn() }))
vi.mock('./translation-status', () => ({ readTranslationStatusByCountryAndLanguage: vi.fn() }))

import { getPool } from './db'
import { readDailyStatusSnapshots } from './status-daily-snapshots'

describe('readDailyStatusSnapshots', () => {
  it('normalizes a Date-typed snapshot_date (node-postgres default parsing for `date` columns) to a plain YYYY-MM-DD string', async () => {
    // Matches how the `postgres-date` package actually builds a `date` column's
    // Date: `new Date(year, month, day)` — local-time fields, not UTC.
    const row = {
      snapshot_date: new Date(2026, 7, 25),
      country: 'de',
      kind: 'crawl',
      target_lang: '',
      done: 1, pending: 2, open: 3, error: 4, total: 10,
      captured_at: new Date('2026-08-25T01:50:07.000Z'),
    }
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [row] }) } as never)

    const [snapshot] = await readDailyStatusSnapshots(14)

    expect(snapshot!.snapshotDate).toBe('2026-08-25')
    // The frontend builds `${snapshotDate}T12:00:00Z` and parses it — must stay a valid Date.
    expect(() => new Intl.DateTimeFormat('de-DE').format(new Date(`${snapshot!.snapshotDate}T12:00:00Z`))).not.toThrow()
  })

  describe('under a positive UTC offset', () => {
    const originalTz = process.env.TZ

    beforeEach(() => { process.env.TZ = 'Europe/Berlin' })
    afterEach(() => { process.env.TZ = originalTz })

    it('keeps the original calendar date instead of shifting it back a day via UTC methods', async () => {
      const row = {
        snapshot_date: new Date(2026, 7, 25), // local midnight — UTC-2h in Berlin summer time
        country: 'de',
        kind: 'crawl',
        target_lang: '',
        done: 0, pending: 0, open: 0, error: 0, total: 0,
        captured_at: new Date('2026-08-25T01:50:07.000Z'),
      }
      vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [row] }) } as never)

      const [snapshot] = await readDailyStatusSnapshots(14)

      expect(snapshot!.snapshotDate).toBe('2026-08-25')
    })
  })

  it('passes through a string snapshot_date unchanged', async () => {
    const row = {
      snapshot_date: '2026-08-25',
      country: 'de',
      kind: 'crawl',
      target_lang: '',
      done: 0, pending: 0, open: 0, error: 0, total: 0,
      captured_at: '2026-08-25T01:50:07.000Z',
    }
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [row] }) } as never)

    const [snapshot] = await readDailyStatusSnapshots(14)

    expect(snapshot!.snapshotDate).toBe('2026-08-25')
  })
})
