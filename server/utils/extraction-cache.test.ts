import { describe, expect, it, vi } from 'vitest'
import type { AuctionExtraction } from '~/types/auction'
import { getPool } from './db'
import { readJsonCache, writeJsonCache } from './json-cache'

vi.mock('./db', () => ({ getPool: vi.fn() }))
vi.mock('./json-cache', () => ({ readJsonCache: vi.fn(), writeJsonCache: vi.fn() }))

const { readExtractionCache, writeExtractionCache } = await import('./extraction-cache')

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

describe('readExtractionCache', () => {
  it('returns the empty local cache when Postgres is not configured', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    vi.mocked(readJsonCache).mockResolvedValue({})

    await expect(readExtractionCache()).resolves.toEqual({})
  })

  it('reconstructs entries from Postgres when the local cache is empty (simulated volume loss)', async () => {
    vi.mocked(readJsonCache).mockResolvedValue({})
    const pool = makeFakePool([{ platform: 'zvg-portal', external_id: '7265', extraction }])
    vi.mocked(getPool).mockReturnValue(pool as never)

    const cache = await readExtractionCache()

    expect(cache['zvg-portal:7265']).toEqual(extraction)
  })

  it('lets the local cache win over Postgres on a conflicting key', async () => {
    const staleExtraction = { ...extraction, confidence: 'low' as const }
    vi.mocked(readJsonCache).mockResolvedValue({ 'zvg-portal:7265': extraction })
    const pool = makeFakePool([{ platform: 'zvg-portal', external_id: '7265', extraction: staleExtraction }])
    vi.mocked(getPool).mockReturnValue(pool as never)

    const cache = await readExtractionCache()

    expect(cache['zvg-portal:7265']).toEqual(extraction)
  })

  it('never throws when the query fails', async () => {
    vi.mocked(readJsonCache).mockResolvedValue({})
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('connection reset')) } as never)

    await expect(readExtractionCache()).resolves.toEqual({})
  })
})

describe('writeExtractionCache', () => {
  it('is a no-op towards Postgres without a configured pool', async () => {
    vi.mocked(getPool).mockReturnValue(null)

    await expect(writeExtractionCache({ 'zvg-portal:7265': extraction })).resolves.toBeUndefined()
    expect(writeJsonCache).toHaveBeenCalledWith(expect.stringContaining('extraction.json'), {
      'zvg-portal:7265': extraction,
    })
  })

  it('upserts every entry into Postgres', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)

    await writeExtractionCache({ 'zvg-portal:7265': extraction })

    expect(pool.upserted).toEqual([{ platform: 'zvg-portal', external_id: '7265', extraction }])
  })

  it('never throws when the query fails', async () => {
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('connection reset')) } as never)

    await expect(writeExtractionCache({ 'zvg-portal:7265': extraction })).resolves.toBeUndefined()
  })
})

describe('volume-loss round trip', () => {
  it('an extraction written to Postgres is read back after the local cache is wiped', async () => {
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    vi.mocked(readJsonCache).mockResolvedValue({ 'zvg-portal:7265': extraction })

    await writeExtractionCache({ 'zvg-portal:7265': extraction })

    // Simulate the local volume being wiped: readJsonCache now returns empty,
    // but Postgres still has what writeExtractionCache upserted above.
    vi.mocked(readJsonCache).mockResolvedValue({})
    const restoredPool = makeFakePool(pool.upserted)
    vi.mocked(getPool).mockReturnValue(restoredPool as never)

    const restored = await readExtractionCache()

    expect(restored['zvg-portal:7265']).toEqual(extraction)
  })
})
