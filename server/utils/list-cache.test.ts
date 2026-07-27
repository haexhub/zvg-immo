import { describe, expect, it, vi } from 'vitest'
import type { CrawlResult } from '~/types/auction'

vi.mock('./db', () => ({ getPool: vi.fn() }))

type Row = { country: string; region: string; result: CrawlResult; fetched_at: string }

const deBy: CrawlResult = {
  platform: 'zvg-portal',
  source: 'zvg-portal',
  countries: ['de'],
  regions: ['Bayern'],
  fetchedAt: '2026-01-01T00:00:00.000Z',
  totalReported: 1,
  auctions: [{ platform: 'zvg-portal', externalId: '1' } as CrawlResult['auctions'][number]],
}

const frIdf: CrawlResult = {
  platform: 'licitor',
  source: 'licitor',
  countries: ['fr'],
  regions: ['Île-de-France'],
  fetchedAt: '2026-01-01T00:00:00.000Z',
  totalReported: 1,
  auctions: [{ platform: 'licitor', externalId: '2' } as CrawlResult['auctions'][number]],
}

const seAll: CrawlResult = {
  platform: 'se-kronofogden',
  source: 'kronofogden',
  countries: ['se'],
  regions: ['Schweden'],
  fetchedAt: '2026-01-01T00:00:00.000Z',
  totalReported: 1,
  auctions: [{ platform: 'se-kronofogden', externalId: '3' } as CrawlResult['auctions'][number]],
}

/** Minimal in-memory stand-in for the `pg` Pool. */
function makeFakePool(rows: Row[] = []) {
  const upserted: Row[] = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT value FROM app_settings WHERE key')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('SELECT result FROM list_cache WHERE country') && sql.includes('region')) {
      const [country, region] = params as [string, string]
      const hit = rows.filter((r) => r.country === country && r.region === region)
      return { rows: hit.map((r) => ({ result: r.result })), rowCount: hit.length }
    }
    if (sql.includes('SELECT result, fetched_at FROM list_cache WHERE country')) {
      const [country, region] = params as [string, string]
      const hit = rows.filter((r) => r.country === country && r.region === region)
      return { rows: hit.map((r) => ({ result: r.result, fetched_at: r.fetched_at })), rowCount: hit.length }
    }
    if (sql.includes('SELECT country, result, fetched_at FROM list_cache')) {
      return {
        rows: rows.map((r) => ({ country: r.country, result: r.result, fetched_at: r.fetched_at })),
        rowCount: rows.length,
      }
    }
    if (sql.includes('SELECT country, result FROM list_cache WHERE country')) {
      const [country] = params as [string]
      const hit = rows.filter((r) => r.country === country)
      return { rows: hit.map((r) => ({ country: r.country, result: r.result })), rowCount: hit.length }
    }
    if (sql.includes('SELECT country, result FROM list_cache')) {
      return { rows: rows.map((r) => ({ country: r.country, result: r.result })), rowCount: rows.length }
    }
    if (sql.includes('SELECT fetched_at FROM list_cache WHERE country')) {
      const [country, region] = params as [string, string]
      const hit = rows.find((r) => r.country === country && r.region === region)
      return { rows: hit ? [{ fetched_at: hit.fetched_at }] : [], rowCount: hit ? 1 : 0 }
    }
    if (sql.includes('INSERT INTO list_cache')) {
      const [country, region, result, fetched_at] = params as [string, string, string, string]
      upserted.push({ country, region, result: JSON.parse(result), fetched_at })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query, upserted }
}

describe('readListCache', () => {
  it('returns null for a paused country without querying list_cache', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([{ country: 'fr', region: 'idf', result: frIdf, fetched_at: frIdf.fetchedAt }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readListCache } = await import('./list-cache')

    expect(await readListCache('fr', 'idf')).toBeNull()
    expect(pool.query).toHaveBeenCalledTimes(1)
    expect(pool.query.mock.calls[0]?.[0]).toContain('app_settings')
  })

  it('serves an enabled country from Postgres', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([{ country: 'de', region: 'by', result: deBy, fetched_at: deBy.fetchedAt }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readListCache } = await import('./list-cache')

    const result = await readListCache('de', 'by')
    expect(result?.auctions).toHaveLength(1)
  })

  it('treats stale country-versioned rows as missing', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([{ country: 'se', region: 'all', result: seAll, fetched_at: seAll.fetchedAt }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readListCache } = await import('./list-cache')

    expect(await readListCache('se', 'all')).toBeNull()
  })

  it('returns null without a configured pool', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(null)
    const { readListCache } = await import('./list-cache')

    expect(await readListCache('de', 'by')).toBeNull()
  })
})

describe('writeListCache', () => {
  it('is a no-op without a configured pool', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(null)
    const { writeListCache } = await import('./list-cache')

    await expect(writeListCache('de', 'by', deBy)).resolves.toBeUndefined()
  })

  it('upserts the region row', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { writeListCache } = await import('./list-cache')

    await writeListCache('de', 'by', deBy)

    expect(pool.upserted).toEqual([{ country: 'de', region: 'by', result: deBy, fetched_at: deBy.fetchedAt }])
  })

  it('adds the current country cache version when needed', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { writeListCache } = await import('./list-cache')

    await writeListCache('se', 'all', seAll)

    expect(pool.upserted[0]?.result.listCacheVersion).toBe(1)
  })
})

describe('readMergedListCache', () => {
  it('merges all regions and excludes a paused country', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([
      { country: 'de', region: 'by', result: deBy, fetched_at: deBy.fetchedAt },
      { country: 'fr', region: 'idf', result: frIdf, fetched_at: frIdf.fetchedAt },
    ])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readMergedListCache } = await import('./list-cache')

    const result = await readMergedListCache()
    expect(result?.auctions.map((a) => a.platform)).toEqual(['zvg-portal'])
  })

  it('excludes stale country-versioned rows from merged results', async () => {
    const { getPool } = await import('./db')
    const freshSe = { ...seAll, listCacheVersion: 1 }
    const pool = makeFakePool([
      { country: 'de', region: 'by', result: deBy, fetched_at: deBy.fetchedAt },
      { country: 'se', region: 'all', result: seAll, fetched_at: seAll.fetchedAt },
      { country: 'se', region: 'all-fresh', result: freshSe, fetched_at: freshSe.fetchedAt },
    ])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readMergedListCache } = await import('./list-cache')

    const result = await readMergedListCache()
    expect(result?.auctions.map((a) => a.externalId)).toEqual(['1', '3'])
  })

  it('deduplicates auctions that appear in multiple cached rows for a country', async () => {
    const { getPool } = await import('./db')
    const olderSe = {
      ...seAll,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      listCacheVersion: 1,
      auctions: [
        { platform: 'se-kronofogden', externalId: '3', title: 'old' },
        { platform: 'se-kronofogden', externalId: '4' },
      ] as CrawlResult['auctions'],
    }
    const newerSe = {
      ...seAll,
      fetchedAt: '2026-01-01T01:00:00.000Z',
      listCacheVersion: 1,
      auctions: [
        { platform: 'se-kronofogden', externalId: '3', title: 'new' },
      ] as CrawlResult['auctions'],
    }
    const pool = makeFakePool([
      { country: 'se', region: 'all-old', result: olderSe, fetched_at: olderSe.fetchedAt },
      { country: 'se', region: 'all', result: newerSe, fetched_at: newerSe.fetchedAt },
    ])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readMergedListCache } = await import('./list-cache')

    const result = await readMergedListCache('se')
    expect(result?.auctions.map((a) => a.externalId)).toEqual(['3', '4'])
    expect(result?.auctions.find((a) => a.externalId === '3')?.title).toBe('new')
  })

  it('filters to one country when given', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([{ country: 'de', region: 'by', result: deBy, fetched_at: deBy.fetchedAt }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readMergedListCache } = await import('./list-cache')

    const result = await readMergedListCache('de')
    expect(result?.countries).toEqual(['de'])
  })

  it('returns null without a configured pool', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(null)
    const { readMergedListCache } = await import('./list-cache')

    expect(await readMergedListCache()).toBeNull()
  })
})

describe('cache age helpers', () => {
  it('regionListCacheAgeMs computes age from fetched_at', async () => {
    const { getPool } = await import('./db')
    const fetchedAt = new Date(Date.now() - 60_000).toISOString()
    const pool = makeFakePool([{ country: 'de', region: 'by', result: deBy, fetched_at: fetchedAt }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { regionListCacheAgeMs } = await import('./list-cache')

    const age = await regionListCacheAgeMs('de', 'by')
    expect(age).toBeGreaterThanOrEqual(60_000)
  })

  it('regionListCacheAgeMs returns null for an unseen region', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { regionListCacheAgeMs } = await import('./list-cache')

    expect(await regionListCacheAgeMs('de', 'nrw')).toBeNull()
  })

  it('regionListCacheAgeMs returns null for a stale country-versioned row', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([{ country: 'se', region: 'all', result: seAll, fetched_at: seAll.fetchedAt }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { regionListCacheAgeMs } = await import('./list-cache')

    expect(await regionListCacheAgeMs('se', 'all')).toBeNull()
  })

  it('listCacheAgeMs uses the newest fetched_at across all regions', async () => {
    const { getPool } = await import('./db')
    const older = new Date(Date.now() - 3_600_000).toISOString()
    const newer = new Date(Date.now() - 60_000).toISOString()
    const pool = makeFakePool([
      { country: 'de', region: 'by', result: deBy, fetched_at: older },
      { country: 'de', region: 'nrw', result: deBy, fetched_at: newer },
    ])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { listCacheAgeMs } = await import('./list-cache')

    const age = await listCacheAgeMs()
    expect(age).toBeLessThan(120_000)
  })

  it('listCacheAgeMs ignores stale country-versioned rows', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([{ country: 'se', region: 'all', result: seAll, fetched_at: new Date().toISOString() }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { listCacheAgeMs } = await import('./list-cache')

    expect(await listCacheAgeMs()).toBeNull()
  })

  it('listCacheAgeMs returns null when empty', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { listCacheAgeMs } = await import('./list-cache')

    expect(await listCacheAgeMs()).toBeNull()
  })
})
