import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from '../db'
import { findLockedCandidates } from './reprocess-locked-candidates'

vi.mock('../db', () => ({ getPool: vi.fn() }))

const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
  rows: [{ platform: 'zvg-portal', external_id: '7', country: 'de' }] as unknown[],
}))

function lastCall(): { sql: string; params: unknown[] } {
  const [sql, params] = query.mock.calls.at(-1)!
  return { sql, params: params ?? [] }
}

beforeEach(() => {
  query.mockClear()
  vi.mocked(getPool).mockReturnValue({ query } as never)
})

describe('findLockedCandidates', () => {
  it('selects locked auctions without a successful extraction and maps the rows', async () => {
    const rows = await findLockedCandidates({}, ['de'])
    const { sql, params } = lastCall()
    expect(sql).toContain('s.llm_failures >= $1')
    expect(sql).toContain('d.llm_analyzed_at IS NOT NULL')
    expect(sql).not.toContain('d.is_latest')
    expect(sql).toContain('a.cancelled = false')
    expect(params.slice(0, 2)).toEqual([3, ['de']])
    expect(rows).toEqual([{ platform: 'zvg-portal', externalId: '7', country: 'de' }])
  })

  it('applies the limit in SQL and orders by the oldest attempt first', async () => {
    await findLockedCandidates({ limit: 40 }, ['de'])
    const { sql, params } = lastCall()
    expect(sql).toMatch(/ORDER BY s\.llm_last_attempted_at ASC NULLS FIRST/)
    expect(sql).toMatch(/LIMIT \$\d+$/)
    expect(params.at(-1)).toBe(40)
  })

  it('scopes to a platform', async () => {
    await findLockedCandidates({ platform: 'kip', ignoreCooldown: true }, ['de'])
    const { sql, params } = lastCall()
    expect(sql).toContain('s.platform = $3')
    expect(params[2]).toBe('kip')
  })

  it('selects only auctions past their exponential failure backoff for the scheduled slice', async () => {
    await findLockedCandidates({ limit: 10 }, ['de'])
    const { sql, params } = lastCall()
    expect(sql).toContain("s.llm_last_attempted_at <= now() - interval '1 hour' *")
    expect(sql).toMatch(/LEAST\(\$4::float8, \$3::float8 \* power\(2::float8, GREATEST\(s\.llm_failures - \$1, 0\)\)\)/)
    expect(params.slice(2, 4)).toEqual([24, 14 * 24])
  })

  it('ignores the backoff for a manual retry', async () => {
    await findLockedCandidates({ ignoreCooldown: true, limit: 10 }, ['de'])
    expect(lastCall().sql).not.toContain('power(2')
  })

  it('skips expired auctions unless one is addressed explicitly', async () => {
    await findLockedCandidates({}, ['bg'])
    expect(lastCall().sql).toContain('a.auction_date_iso IS NULL OR a.auction_date_iso >= now()')
    expect(lastCall().sql).toContain('a.last_seen_at < cs.last_success_at')
    await findLockedCandidates({ platform: 'bg-bcpea', externalId: '1' }, ['bg'])
    expect(lastCall().sql).not.toContain('a.auction_date_iso')
  })

  it('does not hide a cancelled auction that is addressed explicitly', async () => {
    await findLockedCandidates({ platform: 'kip', externalId: 'H1' }, ['de'])
    expect(lastCall().sql).not.toContain('a.cancelled = false')
  })

  it('returns nothing without countries or a database', async () => {
    expect(await findLockedCandidates({}, [])).toEqual([])
    vi.mocked(getPool).mockReturnValue(null as never)
    expect(await findLockedCandidates({}, ['de'])).toEqual([])
  })
})
