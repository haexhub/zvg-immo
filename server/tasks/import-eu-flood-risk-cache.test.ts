import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImportEuFloodRiskCacheTaskSummary } from './import-eu-flood-risk-cache'

vi.mock('~/server/utils/external-data/eu-flood-risk-import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/external-data/eu-flood-risk-import')>()
  return {
    ...actual,
    importEuFloodRiskGeoJsonCache: vi.fn(),
  }
})
vi.mock('~/server/utils/db', () => ({ getPool: vi.fn(() => null) }))

afterEach(async () => {
  vi.unstubAllGlobals()
  // clearAllMocks only drops recorded calls, so a stubStoredGeoJsonPath() from
  // one test would otherwise still answer the next one's app_settings read.
  const { getPool } = await import('~/server/utils/db')
  vi.mocked(getPool).mockReturnValue(null)
  vi.resetModules()
  vi.clearAllMocks()
})

function summaryFixture(cachePath: string): ImportEuFloodRiskCacheTaskSummary {
  return {
    cachePath,
    serviceUrl: 'https://example.test/arcgis',
    sourceVersion: 'eea-floods-2019-riskzone-r00-2026-08-11',
    generatedAt: '2026-07-27T00:00:00.000Z',
    fetched: 2,
    normalized: 2,
    pages: 1,
  }
}

/** app_settings row for the eu-flood-risk-areas source config. */
async function stubStoredGeoJsonPath(geoJsonPath: string): Promise<void> {
  const { getPool } = await import('~/server/utils/db')
  vi.mocked(getPool).mockReturnValue({
    query: async (sql: string, params: unknown[] = []) => {
      const [key] = params as [string]
      return sql.includes('SELECT value FROM app_settings WHERE key =')
        && key === 'external_data_config_eu-flood-risk-areas'
        ? { rows: [{ value: { geoJsonPath } }] }
        : { rows: [] }
    },
  } as never)
}

describe('runImportEuFloodRiskCache', () => {
  it('imports the EU flood cache with official defaults', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { importEuFloodRiskGeoJsonCache, EU_FLOOD_RISK_POLYGON_LAYER_URL } = await import('~/server/utils/external-data/eu-flood-risk-import')
    vi.mocked(importEuFloodRiskGeoJsonCache).mockResolvedValue({
      cachePath: '/tmp/eu-flood-risk.geojson',
      serviceUrl: EU_FLOOD_RISK_POLYGON_LAYER_URL,
      sourceVersion: 'eea-floods-2019-riskzone-r00-2026-08-11',
      generatedAt: '2026-07-27T00:00:00.000Z',
      fetched: 2,
      normalized: 2,
      pages: 1,
    })

    const { runImportEuFloodRiskCache } = await import('./import-eu-flood-risk-cache')
    const summary = await runImportEuFloodRiskCache({
      cachePath: '/tmp/eu-flood-risk.geojson',
      generatedAt: '2026-07-27T00:00:00.000Z',
      countryCodes: ['de', 'fr'],
    })

    expect(summary.normalized).toBe(2)
    expect(importEuFloodRiskGeoJsonCache).toHaveBeenCalledWith({
      cachePath: '/tmp/eu-flood-risk.geojson',
      serviceUrl: EU_FLOOD_RISK_POLYGON_LAYER_URL,
      sourceVersion: 'eea-floods-2019-riskzone-r00-2026-08-11',
      generatedAt: '2026-07-27T00:00:00.000Z',
      pageSize: undefined,
      maxPages: undefined,
      countryCodes: ['de', 'fr'],
    })
  })

  it('scopes an unspecified import to the countries this instance crawls', async () => {
    // The layer holds 8,130 zones across 19 reporting countries; DE+SE+BG are
    // 650 of them. Without this the button pulls the whole continent.
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({
      query: async (sql: string) => (
        sql.includes('SELECT DISTINCT country FROM auctions')
          ? { rows: [{ country: 'de' }, { country: 'se' }, { country: null }, { country: 'xx1' }] }
          : { rows: [] }
      ),
    } as never)
    const { importEuFloodRiskGeoJsonCache } = await import('~/server/utils/external-data/eu-flood-risk-import')
    vi.mocked(importEuFloodRiskGeoJsonCache).mockResolvedValue(summaryFixture('/tmp/eu-flood-risk.geojson'))

    const { runImportEuFloodRiskCache } = await import('./import-eu-flood-risk-cache')
    await runImportEuFloodRiskCache({ cachePath: '/tmp/eu-flood-risk.geojson' })

    expect(vi.mocked(importEuFloodRiskGeoJsonCache).mock.calls[0]?.[0].countryCodes).toEqual(['DE', 'SE'])
  })

  it('imports every country when no crawled country is known', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { importEuFloodRiskGeoJsonCache } = await import('~/server/utils/external-data/eu-flood-risk-import')
    vi.mocked(importEuFloodRiskGeoJsonCache).mockResolvedValue(summaryFixture('/tmp/eu-flood-risk.geojson'))

    const { runImportEuFloodRiskCache } = await import('./import-eu-flood-risk-cache')
    await runImportEuFloodRiskCache({ cachePath: '/tmp/eu-flood-risk.geojson' })

    expect(vi.mocked(importEuFloodRiskGeoJsonCache).mock.calls[0]?.[0].countryCodes).toBeUndefined()
  })

  it('writes to the path the hazard adapter reads, not the cwd default', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    vi.stubGlobal('useRuntimeConfig', () => ({
      externalData: { euFloodRiskGeoJsonPath: '/env/eu-flood-risk.geojson' },
    }))
    const { importEuFloodRiskGeoJsonCache } = await import('~/server/utils/external-data/eu-flood-risk-import')
    vi.mocked(importEuFloodRiskGeoJsonCache).mockResolvedValue(summaryFixture('/db/eu-flood-risk.geojson'))
    await stubStoredGeoJsonPath('/db/eu-flood-risk.geojson')

    const { runImportEuFloodRiskCache } = await import('./import-eu-flood-risk-cache')
    await runImportEuFloodRiskCache({ generatedAt: '2026-07-27T00:00:00.000Z' })

    expect(vi.mocked(importEuFloodRiskGeoJsonCache).mock.calls[0]?.[0].cachePath)
      .toBe('/db/eu-flood-risk.geojson')
  })
})

describe('import-eu-flood-risk-cache task', () => {
  it('stays inert on a scheduled run while the source has no configured path', async () => {
    // nuxt.config.ts runs this monthly; paginating the whole EU layer into a
    // file no adapter opens is exactly the "empty values keep it inert"
    // contract the externalData runtimeConfig documents.
    vi.stubGlobal('defineTask', (def: unknown) => def)
    vi.stubGlobal('useRuntimeConfig', () => ({ externalData: {} }))
    const { importEuFloodRiskGeoJsonCache } = await import('~/server/utils/external-data/eu-flood-risk-import')

    const task = (await import('./import-eu-flood-risk-cache')).default as unknown as {
      run: (event?: { payload?: unknown }) => Promise<{ result: unknown }>
    }
    const { result } = await task.run({})

    expect(result).toEqual({ skipped: 'eu-flood-risk-areas has no configured cache path' })
    expect(importEuFloodRiskGeoJsonCache).not.toHaveBeenCalled()
  })

  it('runs a scheduled import once the source is configured', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    vi.stubGlobal('useRuntimeConfig', () => ({
      externalData: { euFloodRiskGeoJsonPath: '/env/eu-flood-risk.geojson' },
    }))
    const { importEuFloodRiskGeoJsonCache } = await import('~/server/utils/external-data/eu-flood-risk-import')
    vi.mocked(importEuFloodRiskGeoJsonCache).mockResolvedValue(summaryFixture('/env/eu-flood-risk.geojson'))

    const task = (await import('./import-eu-flood-risk-cache')).default as unknown as {
      run: (event?: { payload?: unknown }) => Promise<{ result: unknown }>
    }
    await task.run({})

    expect(vi.mocked(importEuFloodRiskGeoJsonCache).mock.calls[0]?.[0].cachePath)
      .toBe('/env/eu-flood-risk.geojson')
  })
})
