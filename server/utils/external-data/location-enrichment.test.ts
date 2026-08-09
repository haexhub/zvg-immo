import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocationEnrichment } from '~/types/auction'
import type { LocationEnrichmentCache } from './location-enrichment'

vi.mock('../db', () => ({ getPool: vi.fn() }))

const enrichment: LocationEnrichment = {
  platform: 'zvg-portal',
  externalId: '7265',
  lat: 48.137,
  lng: 11.575,
  checkedAt: '2026-07-26T10:00:00.000Z',
  sourceVersion: 'test-fixture',
  marketComparison: {
    pricePerSqm: 4000,
    basis: 'livingArea',
    areaSqm: 100,
    regionLabel: 'Muenchen',
    propertyClass: 'house',
    medianPricePerSqm: 5000,
    p25PricePerSqm: 4200,
    p75PricePerSqm: 6200,
    deltaPctVsMedian: -20,
    verdict: 'cheaper',
    samples: 12,
    sources: [{
      id: 'fr-dvf-geolocated',
      label: 'Demandes de valeurs foncieres geolocalisees',
      url: 'https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres-geolocalisees',
      licenseNote: 'Fixture',
    }],
  },
  hazards: [{
    hazard: 'flood',
    status: 'outside',
    severity: 'unknown',
    distanceMeters: 1200,
    sourceLabel: 'EU Flood Risk Areas',
    sourceUrl: 'https://water.europa.eu/freshwater/resources/eu-flood-risk-areas-viewer',
    checkedAt: '2026-07-26T10:00:00.000Z',
  }],
}

function makeFakePool(rows: Array<{
  platform: string
  external_id: string
  enrichment: LocationEnrichment
  checked_at: string | Date
}> = []) {
  const upserted: Array<{
    platform: string
    external_id: string
    enrichment: LocationEnrichment
    checked_at: string
  }> = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('WHERE platform = $1 AND external_id = $2')) {
      const [platform, externalId] = params
      const row = rows.find((entry) => entry.platform === platform && entry.external_id === externalId)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('SELECT platform, external_id, enrichment, checked_at FROM location_enrichment')) {
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('INSERT INTO location_enrichment')) {
      for (let i = 0; i < params.length; i += 4) {
        upserted.push({
          platform: params[i] as string,
          external_id: params[i + 1] as string,
          enrichment: JSON.parse(params[i + 2] as string),
          checked_at: params[i + 3] as string,
        })
      }
      return { rows: [], rowCount: params.length / 4 }
    }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { query, upserted }
}

afterEach(() => {
  vi.resetModules()
})

describe('readLocationEnrichmentCache', () => {
  it('returns an empty cache when Postgres is not configured', async () => {
    const { getPool } = await import('../db')
    vi.mocked(getPool).mockReturnValue(null)
    const { readLocationEnrichmentCache } = await import('./location-enrichment')

    await expect(readLocationEnrichmentCache()).resolves.toEqual({})
  })

  it('keeps the full-table cache for batch consumers, while detail reads use their identity key', async () => {
    const { getPool } = await import('../db')
    const pool = makeFakePool([{ platform: 'zvg-portal', external_id: '7265', enrichment, checked_at: enrichment.checkedAt }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readLocationEnrichmentCache, readLocationEnrichment } = await import('./location-enrichment')

    const cache = await readLocationEnrichmentCache()

    expect(cache['zvg-portal:7265']).toEqual(enrichment)
    await expect(readLocationEnrichment('zvg-portal', '7265')).resolves.toEqual(enrichment)
    expect(pool.query).toHaveBeenCalledTimes(2)
    expect(pool.query.mock.calls[1]).toEqual(expect.arrayContaining([
      expect.stringContaining('WHERE platform = $1 AND external_id = $2'),
      ['zvg-portal', '7265'],
    ]))
    await expect(readLocationEnrichment('zvg-portal', '7265')).resolves.toEqual(enrichment)
    expect(pool.query).toHaveBeenCalledTimes(2)
  })

  it('returns null for a keyed detail-cache miss without falling back to the full-table query', async () => {
    const { getPool } = await import('../db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readLocationEnrichment } = await import('./location-enrichment')

    await expect(readLocationEnrichment('zvg-portal', 'missing')).resolves.toBeNull()
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE platform = $1 AND external_id = $2'), ['zvg-portal', 'missing'])
  })

  it('serves subsequent calls from memory without re-querying Postgres', async () => {
    const { getPool } = await import('../db')
    const pool = makeFakePool([{ platform: 'zvg-portal', external_id: '7265', enrichment, checked_at: enrichment.checkedAt }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readLocationEnrichmentCache } = await import('./location-enrichment')

    await readLocationEnrichmentCache()
    await readLocationEnrichmentCache()

    expect(pool.query).toHaveBeenCalledTimes(1)
  })
})

describe('writeLocationEnrichmentCache', () => {
  it('is a no-op towards Postgres without a configured pool, but still updates memory', async () => {
    const { getPool } = await import('../db')
    vi.mocked(getPool).mockReturnValue(null)
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('./location-enrichment')

    await writeLocationEnrichmentCache({ 'zvg-portal:7265': enrichment })

    const cache = await readLocationEnrichmentCache()
    expect(cache['zvg-portal:7265']).toEqual(enrichment)
  })

  it('upserts only the entries passed by the caller', async () => {
    const { getPool } = await import('../db')
    const pool = makeFakePool([{ platform: 'zvg-portal', external_id: '1111', enrichment, checked_at: enrichment.checkedAt }])
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readLocationEnrichmentCache, writeLocationEnrichmentCache } = await import('./location-enrichment')

    await readLocationEnrichmentCache()
    const next: LocationEnrichmentCache = {
      'zvg-portal:2222': { ...enrichment, externalId: '2222' },
    }
    await writeLocationEnrichmentCache(next)

    expect(pool.upserted).toEqual([{
      platform: 'zvg-portal',
      external_id: '2222',
      enrichment: next['zvg-portal:2222'],
      checked_at: enrichment.checkedAt,
    }])
  })

  it('makes a just-written detail record visible without reading the full table again', async () => {
    const { getPool } = await import('../db')
    const pool = makeFakePool()
    vi.mocked(getPool).mockReturnValue(pool as never)
    const { readLocationEnrichment, writeLocationEnrichmentCache } = await import('./location-enrichment')

    await writeLocationEnrichmentCache({ 'zvg-portal:7265': enrichment })
    await expect(readLocationEnrichment('zvg-portal', '7265')).resolves.toEqual(enrichment)
    expect(pool.query.mock.calls.filter(([sql]) => (sql as string).includes('FROM location_enrichment'))).toHaveLength(1)
  })

  it('returns false when the upsert fails', async () => {
    const { getPool } = await import('../db')
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('connection reset')) } as never)
    const { writeLocationEnrichmentCache } = await import('./location-enrichment')

    await expect(writeLocationEnrichmentCache({ 'zvg-portal:7265': enrichment })).resolves.toBe(false)
  })
})
