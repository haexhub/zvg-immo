import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/_health/db', () => {
  it('is ok when no index is invalid and every expected index exists', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('NOT indisvalid')) return { rows: [] }
      if (sql.includes('pg_indexes')) {
        return {
          rows: [
            'idx_osm_local_elements_tag_natural',
            'idx_osm_local_elements_tag_waterway',
            'idx_osm_local_elements_tag_water',
            'idx_osm_local_elements_tag_place',
            'idx_osm_local_elements_tag_aeroway',
            'idx_osm_local_elements_geog',
            'idx_osm_local_elements_geom',
          ].map((index_name) => ({ index_name })),
        }
      }
      throw new Error(`unexpected query: ${sql}`)
    })
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const handler = (await import('./db.get')).default as unknown as () => Promise<unknown>

    await expect(handler()).resolves.toMatchObject({ ok: true, checked: true, invalidIndexes: [], missingIndexes: [] })
  })

  it('flags both an invalid index and a fully missing one, mirroring the prod incident', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('NOT indisvalid')) {
        return {
          rows: [
            { index_name: 'idx_osm_local_elements_geog' },
            { index_name: 'idx_osm_local_elements_tag_place' },
          ],
        }
      }
      if (sql.includes('pg_indexes')) {
        // aeroway never got created — same effect as invalid, but indisvalid
        // alone would miss it entirely.
        return {
          rows: [
            'idx_osm_local_elements_tag_natural',
            'idx_osm_local_elements_tag_waterway',
            'idx_osm_local_elements_tag_water',
            'idx_osm_local_elements_tag_place',
            'idx_osm_local_elements_geog',
            'idx_osm_local_elements_geom',
          ].map((index_name) => ({ index_name })),
        }
      }
      throw new Error(`unexpected query: ${sql}`)
    })
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({ query } as never)
    const handler = (await import('./db.get')).default as unknown as () => Promise<unknown>

    await expect(handler()).resolves.toMatchObject({
      ok: false,
      checked: true,
      invalidIndexes: ['idx_osm_local_elements_geog', 'idx_osm_local_elements_tag_place'],
      missingIndexes: ['idx_osm_local_elements_tag_aeroway'],
    })
  })

  it('reports unchecked instead of throwing when the serving database is not configured', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue(null)
    const handler = (await import('./db.get')).default as unknown as () => Promise<unknown>

    await expect(handler()).resolves.toMatchObject({ ok: true, checked: false })
  })
})
