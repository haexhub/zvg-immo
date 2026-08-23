import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImportEurostatTourismNutsCacheSummary } from '~/server/utils/external-data/eurostat-tourism-nuts-import'

vi.mock('~/server/utils/external-data/eurostat-tourism-nuts-import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/external-data/eurostat-tourism-nuts-import')>()
  return { ...actual, importEurostatTourismNutsCache: vi.fn() }
})
vi.mock('~/server/utils/db', () => ({ getPool: vi.fn(() => null) }))

afterEach(async () => {
  vi.unstubAllGlobals()
  const { getPool } = await import('~/server/utils/db')
  vi.mocked(getPool).mockReturnValue(null)
  vi.resetModules()
  vi.clearAllMocks()
})

function summaryFixture(cachePath: string): ImportEurostatTourismNutsCacheSummary {
  return {
    cachePath,
    generatedAt: '2026-08-22T00:00:00.000Z',
    sourceVersion: 'eurostat-tour_occ_nin2-p_km2-gisco-nuts2024-20m',
    regionCount: 242,
    regionsWithData: 231,
  }
}

/** app_settings row for the eurostat-regional-tourism-nights source config. */
async function stubStoredCachePath(cachePath: string): Promise<void> {
  const { getPool } = await import('~/server/utils/db')
  vi.mocked(getPool).mockReturnValue({
    query: async (sql: string, params: unknown[] = []) => {
      const [key] = params as [string]
      return sql.includes('SELECT value FROM app_settings WHERE key =')
        && key === 'external_data_config_eurostat-regional-tourism-nights'
        ? { rows: [{ value: { cachePath } }] }
        : { rows: [] }
    },
  } as never)
}

describe('runImportEurostatTourismNutsCache', () => {
  it('imports with an explicit cachePath', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { importEurostatTourismNutsCache } = await import('~/server/utils/external-data/eurostat-tourism-nuts-import')
    vi.mocked(importEurostatTourismNutsCache).mockResolvedValue(summaryFixture('/tmp/eurostat-tourism-nuts.json'))

    const { runImportEurostatTourismNutsCache } = await import('./import-eurostat-tourism-nuts-cache')
    const summary = await runImportEurostatTourismNutsCache({
      cachePath: '/tmp/eurostat-tourism-nuts.json',
      generatedAt: '2026-08-22T00:00:00.000Z',
    })

    expect(summary.regionCount).toBe(242)
    expect(importEurostatTourismNutsCache).toHaveBeenCalledWith({
      cachePath: '/tmp/eurostat-tourism-nuts.json',
      generatedAt: '2026-08-22T00:00:00.000Z',
      signal: undefined,
    })
  })

  it('writes to the path the read endpoint resolves, not the cwd default', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    vi.stubGlobal('useRuntimeConfig', () => ({
      externalData: { eurostatTourismNutsCachePath: '/env/eurostat-tourism-nuts.json' },
    }))
    const { importEurostatTourismNutsCache } = await import('~/server/utils/external-data/eurostat-tourism-nuts-import')
    vi.mocked(importEurostatTourismNutsCache).mockResolvedValue(summaryFixture('/db/eurostat-tourism-nuts.json'))
    await stubStoredCachePath('/db/eurostat-tourism-nuts.json')

    const { runImportEurostatTourismNutsCache } = await import('./import-eurostat-tourism-nuts-cache')
    await runImportEurostatTourismNutsCache({})

    expect(vi.mocked(importEurostatTourismNutsCache).mock.calls[0]?.[0].cachePath)
      .toBe('/db/eurostat-tourism-nuts.json')
  })
})

describe('import-eurostat-tourism-nuts-cache task', () => {
  it('stays inert on a scheduled run while the source has no configured path', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    vi.stubGlobal('useRuntimeConfig', () => ({ externalData: {} }))
    const { importEurostatTourismNutsCache } = await import('~/server/utils/external-data/eurostat-tourism-nuts-import')

    const task = (await import('./import-eurostat-tourism-nuts-cache')).default as unknown as {
      run: (event?: { payload?: unknown }) => Promise<{ result: unknown }>
    }
    const { result } = await task.run({})

    expect(result).toEqual({ skipped: 'eurostat-regional-tourism-nights has no configured cache path' })
    expect(importEurostatTourismNutsCache).not.toHaveBeenCalled()
  })

  it('runs a scheduled import once the source is configured', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    vi.stubGlobal('useRuntimeConfig', () => ({
      externalData: { eurostatTourismNutsCachePath: '/env/eurostat-tourism-nuts.json' },
    }))
    const { importEurostatTourismNutsCache } = await import('~/server/utils/external-data/eurostat-tourism-nuts-import')
    vi.mocked(importEurostatTourismNutsCache).mockResolvedValue(summaryFixture('/env/eurostat-tourism-nuts.json'))

    const task = (await import('./import-eurostat-tourism-nuts-cache')).default as unknown as {
      run: (event?: { payload?: unknown }) => Promise<{ result: unknown }>
    }
    await task.run({})

    expect(vi.mocked(importEurostatTourismNutsCache).mock.calls[0]?.[0].cachePath)
      .toBe('/env/eurostat-tourism-nuts.json')
  })
})
