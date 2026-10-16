import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImportCopernicusEffisCacheTaskSummary } from './import-copernicus-effis-cache'

vi.mock('~/server/utils/external-data/copernicus-effis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/external-data/copernicus-effis')>()
  return {
    ...actual,
    importCopernicusEffisBurntAreaCache: vi.fn(),
  }
})
vi.mock('~/server/utils/db', () => ({ getPool: vi.fn(() => null) }))

afterEach(async () => {
  vi.unstubAllGlobals()
  const { getPool } = await import('~/server/utils/db')
  vi.mocked(getPool).mockReturnValue(null)
  vi.resetModules()
  vi.clearAllMocks()
})

function summaryFixture(cachePath: string): ImportCopernicusEffisCacheTaskSummary {
  return {
    cachePath,
    serviceUrl: 'https://example.test/effis',
    sourceVersion: 'jrc-modis-ba-poly-2026-07-29',
    generatedAt: '2026-07-29T00:00:00.000Z',
    fetched: 2,
    normalized: 2,
    pages: 1,
  }
}

/** app_settings row for the copernicus-effis source config. */
async function stubStoredCachePath(cachePath: string): Promise<void> {
  const { getPool } = await import('~/server/utils/db')
  vi.mocked(getPool).mockReturnValue({
    query: async (sql: string, params: unknown[] = []) => {
      const [key] = params as [string]
      return sql.includes('SELECT value FROM app_settings WHERE key =')
        && key === 'external_data_config_copernicus-effis'
        ? { rows: [{ value: { cachePath } }] }
        : { rows: [] }
    },
  } as never)
}

describe('runImportCopernicusEffisCache', () => {
  it('imports the EFFIS burnt-area cache with defaults', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { importCopernicusEffisBurntAreaCache, COPERNICUS_EFFIS_SOURCE_VERSION, COPERNICUS_EFFIS_WFS_URL } = await import('~/server/utils/external-data/copernicus-effis')
    vi.mocked(importCopernicusEffisBurntAreaCache).mockResolvedValue({
      cachePath: '/tmp/copernicus-effis.json',
      serviceUrl: COPERNICUS_EFFIS_WFS_URL,
      sourceVersion: COPERNICUS_EFFIS_SOURCE_VERSION,
      generatedAt: '2026-07-29T00:00:00.000Z',
      fetched: 2,
      normalized: 2,
      pages: 1,
    })

    const { runImportCopernicusEffisCache } = await import('./import-copernicus-effis-cache')
    const summary = await runImportCopernicusEffisCache({
      cachePath: '/tmp/copernicus-effis.json',
      generatedAt: '2026-07-29T00:00:00.000Z',
    })

    expect(summary.normalized).toBe(2)
    expect(importCopernicusEffisBurntAreaCache).toHaveBeenCalledWith({
      cachePath: '/tmp/copernicus-effis.json',
      serviceUrl: COPERNICUS_EFFIS_WFS_URL,
      sourceVersion: COPERNICUS_EFFIS_SOURCE_VERSION,
      generatedAt: '2026-07-29T00:00:00.000Z',
      bbox: undefined,
      pageSize: undefined,
      maxPages: undefined,
    })
  })

  it('writes to the path the hazard adapter reads, not the cwd default', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    vi.stubGlobal('useRuntimeConfig', () => ({
      externalData: { copernicusEffisCachePath: '/env/copernicus-effis.json' },
    }))
    const { importCopernicusEffisBurntAreaCache } = await import('~/server/utils/external-data/copernicus-effis')
    vi.mocked(importCopernicusEffisBurntAreaCache).mockResolvedValue(summaryFixture('/db/copernicus-effis.json'))
    await stubStoredCachePath('/db/copernicus-effis.json')

    const { runImportCopernicusEffisCache } = await import('./import-copernicus-effis-cache')
    await runImportCopernicusEffisCache({ generatedAt: '2026-07-29T00:00:00.000Z' })

    expect(vi.mocked(importCopernicusEffisBurntAreaCache).mock.calls[0]?.[0].cachePath)
      .toBe('/db/copernicus-effis.json')
  })
})

describe('import-copernicus-effis-cache task', () => {
  it('stays inert on a scheduled run while the source has no configured path', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    vi.stubGlobal('useRuntimeConfig', () => ({ externalData: {} }))
    const { importCopernicusEffisBurntAreaCache } = await import('~/server/utils/external-data/copernicus-effis')

    const task = (await import('./import-copernicus-effis-cache')).default as unknown as {
      run: (event?: { payload?: unknown }) => Promise<{ result: unknown }>
    }
    const { result } = await task.run({})

    expect(result).toEqual({ skipped: 'copernicus-effis has no configured cache path' })
    expect(importCopernicusEffisBurntAreaCache).not.toHaveBeenCalled()
  })

  it('runs a scheduled import once the source is configured', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    vi.stubGlobal('useRuntimeConfig', () => ({
      externalData: { copernicusEffisCachePath: '/env/copernicus-effis.json' },
    }))
    const { importCopernicusEffisBurntAreaCache } = await import('~/server/utils/external-data/copernicus-effis')
    vi.mocked(importCopernicusEffisBurntAreaCache).mockResolvedValue(summaryFixture('/env/copernicus-effis.json'))

    const task = (await import('./import-copernicus-effis-cache')).default as unknown as {
      run: (event?: { payload?: unknown }) => Promise<{ result: unknown }>
    }
    await task.run({})

    expect(vi.mocked(importCopernicusEffisBurntAreaCache).mock.calls[0]?.[0].cachePath)
      .toBe('/env/copernicus-effis.json')
  })

  // /settings triggers this task detached (see the endpoint), so a persisted
  // status is the only way a failure surfaces at all instead of vanishing
  // with the unwatched promise.
  it('records task-run status around a manual import', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { importCopernicusEffisBurntAreaCache } = await import('~/server/utils/external-data/copernicus-effis')
    vi.mocked(importCopernicusEffisBurntAreaCache).mockResolvedValue(summaryFixture('/tmp/copernicus-effis.json'))
    const { getTaskRunStatus } = await import('~/server/utils/task-runs')

    const task = (await import('./import-copernicus-effis-cache')).default as unknown as {
      run: (event?: { payload?: unknown }) => Promise<{ result: unknown }>
    }
    await task.run({ payload: { cachePath: '/tmp/copernicus-effis.json' } })

    const status = await getTaskRunStatus('import-copernicus-effis-cache')
    expect(status.status).toBe('idle')
    expect(status.lastResult).toEqual({ fetched: 2, normalized: 2, pages: 1 })
    expect(status.lastError).toBeNull()
  })

  it('records the failure instead of losing it when the import throws', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { importCopernicusEffisBurntAreaCache } = await import('~/server/utils/external-data/copernicus-effis')
    vi.mocked(importCopernicusEffisBurntAreaCache).mockRejectedValue(new Error('WFS unreachable'))
    const { getTaskRunStatus } = await import('~/server/utils/task-runs')

    const task = (await import('./import-copernicus-effis-cache')).default as unknown as {
      run: (event?: { payload?: unknown }) => Promise<{ result: unknown }>
    }
    await expect(task.run({ payload: { cachePath: '/tmp/copernicus-effis.json' } })).rejects.toThrow('WFS unreachable')

    const status = await getTaskRunStatus('import-copernicus-effis-cache')
    expect(status.lastError).toBe('WFS unreachable')
  })
})
