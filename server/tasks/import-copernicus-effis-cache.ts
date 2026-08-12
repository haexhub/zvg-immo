import { join } from 'node:path'
import {
  COPERNICUS_EFFIS_SOURCE_VERSION,
  COPERNICUS_EFFIS_WFS_URL,
  importCopernicusEffisBurntAreaCache,
} from '~/server/utils/external-data/copernicus-effis'
import {
  getConfigurableExternalDataSource,
  getStoredExternalDataSourceConfig,
  resolveExternalDataSourceConfig,
} from '~/server/utils/external-data/config'
import { runExclusiveTask, throwIfTaskAborted } from '~/server/utils/exclusive-task'
import { recordTaskRunEnd, recordTaskRunStart } from '~/server/utils/task-runs'

const COPERNICUS_EFFIS_SOURCE_ID = 'copernicus-effis'

export interface ImportCopernicusEffisCachePayload {
  cachePath?: string
  serviceUrl?: string
  sourceVersion?: string
  generatedAt?: string
  bbox?: [number, number, number, number]
  pageSize?: number
  maxPages?: number
}

export interface ImportCopernicusEffisCacheTaskSummary {
  cachePath: string
  serviceUrl: string
  sourceVersion: string
  generatedAt: string
  fetched: number
  normalized: number
  pages: number
}

const DEFAULT_CACHE_PATH = join(process.cwd(), '.cache_zvg', 'external', 'copernicus-effis.json')

// Same rationale as import-eu-flood-risk-cache.ts's configuredCachePath():
// the hazard adapter reads the path resolved by config.ts (DB override >
// env runtimeConfig > field default), so the importer has to write to that
// same path — otherwise a path set from /settings gets refreshed at
// DEFAULT_CACHE_PATH, where nothing reads it.
async function configuredCachePath(): Promise<string | null> {
  const source = getConfigurableExternalDataSource(COPERNICUS_EFFIS_SOURCE_ID)
  if (!source) return null
  const { getPool } = await import('~/server/utils/db')
  const db = getPool()
  const stored = db ? await getStoredExternalDataSourceConfig(db, COPERNICUS_EFFIS_SOURCE_ID) : {}
  const runtimeConfig = typeof useRuntimeConfig === 'function'
    ? (useRuntimeConfig().externalData as Record<string, string | number | undefined> | undefined) ?? {}
    : {}
  const resolved = resolveExternalDataSourceConfig(source, stored, runtimeConfig)
  return resolved.isConfigured ? String(resolved.values.cachePath) : null
}

export default defineTask({
  meta: {
    name: 'import-copernicus-effis-cache',
    description: 'Import Copernicus EFFIS MODIS burnt-area polygons into the local external-data hazard cache.',
  },
  async run(event): Promise<{ result: ImportCopernicusEffisCacheTaskSummary | { skipped: string } }> {
    const payload = (event?.payload ?? {}) as ImportCopernicusEffisCachePayload
    // Scheduled runs stay inert while the source is unconfigured — same
    // contract as import-eu-flood-risk-cache.ts. A manual trigger with an
    // explicit cachePath still runs, so the cache can be pre-populated before
    // configuring the source.
    if (!payload.cachePath?.trim() && !(await configuredCachePath())) {
      const skipped = `${COPERNICUS_EFFIS_SOURCE_ID} has no configured cache path`
      // Recorded even for a no-op: without this, a /settings trigger on an
      // unconfigured source left copernicusEffisImportStatus untouched, so
      // the card's "Import gestartet" message never got contradicted by
      // anything — same bug and fix as import-eu-flood-risk-cache.ts.
      await recordTaskRunStart('import-copernicus-effis-cache')
      await recordTaskRunEnd('import-copernicus-effis-cache', { error: skipped })
      return { result: { skipped } }
    }
    return await runExclusiveTask('import-copernicus-effis-cache', async (signal) => {
      // Recorded (unlike eu-flood-risk/fr-dvf's cache imports) because
      // /settings triggers this one detached rather than sync/awaited: EFFIS's
      // WFS dataset is two orders of magnitude bigger (100k+ features, ~100
      // paginated requests measured live 2026-08-08) — long enough that a
      // synchronous request just times out with nothing to show for it, which
      // is exactly what made the admin's "Import" button look broken. Without
      // a persisted status a failure would vanish with the promise, same
      // rationale as external-enrichment.ts.
      await recordTaskRunStart('import-copernicus-effis-cache')
      try {
        const result = await runImportCopernicusEffisCache(payload)
        throwIfTaskAborted(signal)
        await recordTaskRunEnd('import-copernicus-effis-cache', {
          result: { fetched: result.fetched, normalized: result.normalized, pages: result.pages },
        })
        return { result }
      } catch (err) {
        await recordTaskRunEnd('import-copernicus-effis-cache', { error: (err as Error).message })
        throw err
      }
    })
  },
})

export async function runImportCopernicusEffisCache(
  payload: ImportCopernicusEffisCachePayload = {},
): Promise<ImportCopernicusEffisCacheTaskSummary> {
  const generatedAt = payload.generatedAt ?? new Date().toISOString()
  const sourceVersion = payload.sourceVersion?.trim() || COPERNICUS_EFFIS_SOURCE_VERSION
  const cachePath = payload.cachePath?.trim() || (await configuredCachePath()) || DEFAULT_CACHE_PATH
  const serviceUrl = payload.serviceUrl?.trim() || COPERNICUS_EFFIS_WFS_URL

  return await importCopernicusEffisBurntAreaCache({
    cachePath,
    serviceUrl,
    sourceVersion,
    generatedAt,
    bbox: payload.bbox,
    pageSize: payload.pageSize,
    maxPages: payload.maxPages,
  })
}
