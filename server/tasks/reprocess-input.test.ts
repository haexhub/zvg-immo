import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from '../utils/db'
import { findCandidates } from './reprocess-input'

vi.mock('../utils/db', () => ({ getPool: vi.fn() }))
vi.mock('../crawlers/registry', () => ({
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

  it('keeps the case-number lookup unfiltered too', async () => {
    await findCandidates({ caseNumber: '0032 K 0044/2025' }, ['de'])
    expect(lastSql()).not.toContain('a.cancelled = false')
  })
})
