import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuctionExtraction } from '~/types/auction'

vi.mock('./db', () => ({ getPool: vi.fn() }))

const extraction: AuctionExtraction = {
  propertyType: 'einfamilienhaus',
  landAreaSqm: 1884,
  livingAreaSqm: 447,
  rooms: null,
  units: null,
  source: 'llm',
  confidence: 'high',
  at: '2026-07-21T00:00:00.000Z',
}

/** Minimal in-memory stand-in for the `pg` Pool. */
function makeFakePool(rows: Array<{ platform: string; external_id: string; extraction: AuctionExtraction }> = []) {
  const upserted: Array<{ platform: string; external_id: string; extraction: AuctionExtraction }> = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT platform, external_id, extraction FROM extraction_cache')) {
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('INSERT INTO extraction_cache')) {
      for (let i = 0; i < params.length; i += 3) {
        upserted.push({
          platform: params[i] as string,
          external_id: params[i + 1] as string,
          extraction: JSON.parse(params[i + 2] as string),
        })
      }
      return { rows: [], rowCount: params.length / 3 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query, upserted }
}

// readExtractionCache() memoizes the loaded cache at module scope for the
// process's lifetime, so each test re-imports the module fresh to isolate
// that state (same pattern as geocode.test.ts's backend-selection tests).
afterEach(() => {
  vi.resetModules()
})

describe('readExtractionCache', () => {
  it('returns an empty cache when Postgres is not configured', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(null)
    const { readExtractionCache } = await import('./extraction-cache')

    await expect(readExtractionCache()).resolves.toEqual({})
  })

  it('loads every row from Postgres on first call', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([{ platform: 'zvg-portal', external_id: '7265', extraction }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readExtractionCache } = await import('./extraction-cache')

    const cache = await readExtractionCache()

    expect(cache['zvg-portal:7265']).toEqual(extraction)
  })

  it('serves subsequent calls from memory without re-querying Postgres', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([{ platform: 'zvg-portal', external_id: '7265', extraction }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readExtractionCache } = await import('./extraction-cache')

    await readExtractionCache()
    await readExtractionCache()

    expect(pool.query).toHaveBeenCalledTimes(1)
  })

  it('retries on the next call after a failed load, without caching the failure', async () => {
    const { getPool } = await import('./db')
    const failingPool = { query: vi.fn().mockRejectedValue(new Error('connection reset')) }
    vi.mocked(getPool).mockReturnValue(failingPool as never)
    const { readExtractionCache } = await import('./extraction-cache')

    await expect(readExtractionCache()).resolves.toEqual({})

    const workingPool = makeFakePool([{ platform: 'zvg-portal', external_id: '7265', extraction }])
    vi.mocked(getPool).mockReturnValue(workingPool as never)

    const cache = await readExtractionCache()

    expect(cache['zvg-portal:7265']).toEqual(extraction)
  })
})

describe('writeExtractionCache', () => {
  it('is a no-op towards Postgres without a configured pool, but still updates the in-process cache', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue(null)
    const { readExtractionCache, writeExtractionCache } = await import('./extraction-cache')

    await writeExtractionCache({ 'zvg-portal:7265': extraction })

    const cache = await readExtractionCache()
    expect(cache['zvg-portal:7265']).toEqual(extraction)
  })

  it('upserts only the given entries, not the full in-process cache', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool([{ platform: 'zvg-portal', external_id: '1111', extraction }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readExtractionCache, writeExtractionCache } = await import('./extraction-cache')

    // Load the existing entry into the in-process cache first...
    await readExtractionCache()
    // ...then write only a second, unrelated entry.
    const second: AuctionExtraction = { ...extraction, confidence: 'low' }
    await writeExtractionCache({ 'zvg-portal:2222': second })

    expect(pool.upserted).toEqual([{ platform: 'zvg-portal', external_id: '2222', extraction: second }])
  })

  it('merges written entries into the in-process cache for subsequent reads', async () => {
    const { getPool } = await import('./db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readExtractionCache, writeExtractionCache } = await import('./extraction-cache')

    await writeExtractionCache({ 'zvg-portal:7265': extraction })
    const cache = await readExtractionCache()

    expect(cache['zvg-portal:7265']).toEqual(extraction)
    // The merge is served from memory — no second SELECT round-trip.
    expect(pool.query).not.toHaveBeenCalledWith(expect.stringContaining('SELECT'), expect.anything())
  })

  it('never throws when the query fails', async () => {
    const { getPool } = await import('./db')
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('connection reset')) } as never)
    const { writeExtractionCache } = await import('./extraction-cache')

    await expect(writeExtractionCache({ 'zvg-portal:7265': extraction })).resolves.toBeUndefined()
  })
})
