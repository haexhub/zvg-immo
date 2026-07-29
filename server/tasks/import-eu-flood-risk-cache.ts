import { join } from 'node:path'
import {
  EU_FLOOD_RISK_POLYGON_LAYER_URL,
  EU_FLOOD_RISK_SOURCE_VERSION,
  importEuFloodRiskGeoJsonCache,
} from '~/server/utils/external-data/eu-flood-risk'
import {
  getConfigurableExternalDataSource,
  getStoredExternalDataSourceConfig,
  resolveExternalDataSourceConfig,
} from '~/server/utils/external-data/config'

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
    return { result: await runImportEuFloodRiskCache(payload) }
  },
})

export async function runImportEuFloodRiskCache(
  payload: ImportEuFloodRiskCachePayload = {},
): Promise<ImportEuFloodRiskCacheTaskSummary> {
  const generatedAt = payload.generatedAt ?? new Date().toISOString()
  const sourceVersion = payload.sourceVersion?.trim() || EU_FLOOD_RISK_SOURCE_VERSION
  const cachePath = payload.cachePath?.trim() || (await configuredCachePath()) || DEFAULT_CACHE_PATH
  const serviceUrl = payload.serviceUrl?.trim() || EU_FLOOD_RISK_POLYGON_LAYER_URL

  return await importEuFloodRiskGeoJsonCache({
    cachePath,
    serviceUrl,
    sourceVersion,
    generatedAt,
    pageSize: payload.pageSize,
    maxPages: payload.maxPages,
    countryCodes: payload.countryCodes,
  })
}
