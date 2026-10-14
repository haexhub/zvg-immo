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
    await findLockedCandidates({ platform: 'kip' }, ['de'])
    const { sql, params } = lastCall()
    expect(sql).toContain('s.platform = $3')
    expect(params[2]).toBe('kip')
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
