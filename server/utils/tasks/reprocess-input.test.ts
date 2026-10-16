import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from '../db'
import { findCandidates } from './reprocess-input'

vi.mock('../db', () => ({ getPool: vi.fn() }))
vi.mock('../../crawlers/registry', () => ({
  ensureEnabledCountriesLoaded: vi.fn(async () => ['de']),
  getEnabledCountryCodes: vi.fn(() => ['de']),
  isCountryEnabled: vi.fn(() => true),
}))

const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[] }))

function lastSql(): string {
  return query.mock.calls.at(-1)![0]
}

beforeEach(() => {
  query.mockClear()
  vi.mocked(getPool).mockReturnValue({ query } as never)
})

describe('findCandidates', () => {
  it('excludes cancelled auctions from a country-wide scan', async () => {
    await findCandidates({}, ['de'])
    expect(lastSql()).toContain('a.cancelled = false')
  })

  it('still returns an explicitly addressed auction even when it is cancelled', async () => {
    await findCandidates({ platform: 'bg-bulgarianhouse', externalId: '14537' }, ['bg'])
    expect(lastSql()).not.toContain('a.cancelled = false')
  })

  it('skips expired auctions in a scan but not an explicitly addressed one', async () => {
    await findCandidates({}, ['bg'])
    expect(lastSql()).toContain('a.auction_date_iso IS NULL OR a.auction_date_iso >= now()')
    expect(lastSql()).toContain('a.last_seen_at < cs.last_success_at')
    await findCandidates({ platform: 'bg-bcpea', externalId: '1' }, ['bg'])
    expect(lastSql()).not.toContain('a.auction_date_iso')
  })

  it('hands failedOnly runs to the SQL-level locked selection', async () => {
    await findCandidates({ failedOnly: true, limit: 10 }, ['de'])
    expect(lastSql()).toContain('s.llm_failures >= $1')
    expect(lastSql()).toContain('FROM auction_fetch_state s')
  })

  it('keeps the case-number lookup unfiltered too', async () => {
    await findCandidates({ caseNumber: '0032 K 0044/2025' }, ['de'])
    expect(lastSql()).not.toContain('a.cancelled = false')
  })
})
