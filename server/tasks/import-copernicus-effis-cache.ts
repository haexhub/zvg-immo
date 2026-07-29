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
      return { result: { skipped: `${COPERNICUS_EFFIS_SOURCE_ID} has no configured cache path` } }
    }
    return { result: await runImportCopernicusEffisCache(payload) }
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
