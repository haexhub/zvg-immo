import { join } from 'node:path'
import {
  EU_FLOOD_RISK_POLYGON_LAYER_URL,
  EU_FLOOD_RISK_SOURCE_VERSION,
  importEuFloodRiskGeoJsonCache,
} from '~/server/utils/external-data/eu-flood-risk-import'
import {
  getConfigurableExternalDataSource,
  getStoredExternalDataSourceConfig,
  resolveExternalDataSourceConfig,
} from '~/server/utils/external-data/config'
import { runExclusiveTask, throwIfTaskAborted } from '~/server/utils/exclusive-task'
import { recordTaskRunEnd, recordTaskRunStart } from '~/server/utils/task-runs'

const EU_FLOOD_RISK_SOURCE_ID = 'eu-flood-risk-areas'

export interface ImportEuFloodRiskCachePayload {
  cachePath?: string
  serviceUrl?: string
  sourceVersion?: string
  generatedAt?: string
  pageSize?: number
  maxPages?: number
  countryCodes?: string[]
}

export interface ImportEuFloodRiskCacheTaskSummary {
  cachePath: string
  serviceUrl: string
  sourceVersion: string
  generatedAt: string
  fetched: number
  normalized: number
  pages: number
}

const DEFAULT_CACHE_PATH = join(process.cwd(), '.cache_zvg', 'external', 'eu-flood-risk.geojson')

// The hazard adapter reads the path resolved by server/utils/external-data/
// config.ts (DB override from /settings > env runtimeConfig > field default),
// so the importer has to write to that same path — otherwise a path set from
// /settings gets refreshed at DEFAULT_CACHE_PATH, where nothing reads it.
// null = the source has no configured path anywhere.
async function configuredCachePath(): Promise<string | null> {
  const source = getConfigurableExternalDataSource(EU_FLOOD_RISK_SOURCE_ID)
  if (!source) return null
  // Dynamic import so unit tests that pass an explicit cachePath never pull in
  // the pg pool, same as app-settings.ts's readLlmExecutionMode().
  const { getPool } = await import('~/server/utils/db')
  const db = getPool()
  const stored = db ? await getStoredExternalDataSourceConfig(db, EU_FLOOD_RISK_SOURCE_ID) : {}
  const runtimeConfig = typeof useRuntimeConfig === 'function'
    ? (useRuntimeConfig().externalData as Record<string, string | number | undefined> | undefined) ?? {}
    : {}
  const resolved = resolveExternalDataSourceConfig(source, stored, runtimeConfig)
  return resolved.isConfigured ? String(resolved.values.geoJsonPath) : null
}

export default defineTask({
  meta: {
    name: 'import-eu-flood-risk-cache',
    description: 'Import EU Flood Risk Areas polygons into the local external-data hazard cache.',
  },
  async run(event): Promise<{ result: ImportEuFloodRiskCacheTaskSummary | { skipped: string } }> {
    const payload = (event?.payload ?? {}) as ImportEuFloodRiskCachePayload
    // Scheduled runs (nuxt.config.ts's monthly cron) stay inert while the
    // source is unconfigured — same contract as the external-enrichment task,
    // and it avoids paginating the whole EU layer every month into a file no
    // adapter will ever open. A manual trigger with an explicit cachePath
    // (server/api/settings/external-data/eu-flood-risk-cache.post.ts) still
    // runs, so the cache can be pre-populated before configuring the source.
    if (!payload.cachePath?.trim() && !(await configuredCachePath())) {
      return { result: { skipped: `${EU_FLOOD_RISK_SOURCE_ID} has no configured cache path` } }
    }
    return await runExclusiveTask('import-eu-flood-risk-cache', async (signal) => {
      // Recorded because /settings triggers this detached: even generalized
      // and country-scoped, paginating the layer takes minutes, and without a
      // persisted status a failure would vanish with the promise — same
      // rationale as import-copernicus-effis-cache.ts.
      await recordTaskRunStart('import-eu-flood-risk-cache')
      try {
        const result = await runImportEuFloodRiskCache(payload)
        throwIfTaskAborted(signal)
        await recordTaskRunEnd('import-eu-flood-risk-cache', {
          result: { fetched: result.fetched, normalized: result.normalized, pages: result.pages },
        })
        return { result }
      } catch (err) {
        await recordTaskRunEnd('import-eu-flood-risk-cache', { error: (err as Error).message })
        throw err
      }
    })
  },
})

export async function runImportEuFloodRiskCache(
  payload: ImportEuFloodRiskCachePayload = {},
): Promise<ImportEuFloodRiskCacheTaskSummary> {
  const generatedAt = payload.generatedAt ?? new Date().toISOString()
  const sourceVersion = payload.sourceVersion?.trim() || EU_FLOOD_RISK_SOURCE_VERSION
  const cachePath = payload.cachePath?.trim() || (await configuredCachePath()) || DEFAULT_CACHE_PATH
  const serviceUrl = payload.serviceUrl?.trim() || EU_FLOOD_RISK_POLYGON_LAYER_URL
  const countryCodes = payload.countryCodes ?? await crawledCountryCodes()

  return await importEuFloodRiskGeoJsonCache({
    cachePath,
    serviceUrl,
    sourceVersion,
    generatedAt,
    pageSize: payload.pageSize,
    maxPages: payload.maxPages,
    countryCodes,
  })
}

/**
 * The countries this instance actually crawls, so the import pulls the flood
 * zones it can use instead of all 19 reporting countries — with DE/SE/BG that
 * is 650 of 8,130 zones. Returns undefined when the set can't be determined,
 * which keeps the previous unfiltered behaviour rather than silently importing
 * nothing.
 */
async function crawledCountryCodes(): Promise<string[] | undefined> {
  const { getPool } = await import('~/server/utils/db')
  const db = getPool()
  if (!db) return undefined
  const { rows } = await db.query<{ country: string | null }>(
    'SELECT DISTINCT country FROM auctions WHERE country IS NOT NULL',
  )
  const codes = rows
    .map((row) => row.country?.trim().toUpperCase())
    .filter((code): code is string => !!code && /^[A-Z]{2}$/.test(code))
  return codes.length > 0 ? codes : undefined
}
