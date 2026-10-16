import { join } from 'node:path'
import {
  importEurostatTourismNutsCache,
  type ImportEurostatTourismNutsCacheSummary,
} from '~/server/utils/external-data/eurostat-tourism-nuts-import'
import {
  getConfigurableExternalDataSource,
  getStoredExternalDataSourceConfig,
  resolveExternalDataSourceConfig,
} from '~/server/utils/external-data/config'
import { runExclusiveTask, throwIfTaskAborted } from '~/server/utils/exclusive-task'
import { recordTaskRunEnd, recordTaskRunStart } from '~/server/utils/task-runs'

const EUROSTAT_TOURISM_NUTS_SOURCE_ID = 'eurostat-regional-tourism-nights'

export interface ImportEurostatTourismNutsCachePayload {
  cachePath?: string
  generatedAt?: string
}

const DEFAULT_CACHE_PATH = join(process.cwd(), '.cache_zvg', 'external', 'eurostat-tourism-nuts.json')

// Mirrors import-eu-flood-risk-cache.ts's configuredCachePath(): the read
// endpoint resolves its path the same way (DB override > env runtimeConfig >
// field default), so the importer must write to that same resolved path.
async function configuredCachePath(): Promise<string | null> {
  const source = getConfigurableExternalDataSource(EUROSTAT_TOURISM_NUTS_SOURCE_ID)
  if (!source) return null
  const { getPool } = await import('~/server/utils/db')
  const db = getPool()
  const stored = db ? await getStoredExternalDataSourceConfig(db, EUROSTAT_TOURISM_NUTS_SOURCE_ID) : {}
  const runtimeConfig = typeof useRuntimeConfig === 'function'
    ? (useRuntimeConfig().externalData as Record<string, string | number | undefined> | undefined) ?? {}
    : {}
  const resolved = resolveExternalDataSourceConfig(source, stored, runtimeConfig)
  return resolved.isConfigured ? String(resolved.values.cachePath) : null
}

export default defineTask({
  meta: {
    name: 'import-eurostat-tourism-nuts-cache',
    description: 'Import Eurostat regional tourism nights (NUTS2) + GISCO boundaries into the local map-overlay cache.',
  },
  async run(event): Promise<{ result: ImportEurostatTourismNutsCacheSummary | { skipped: string } }> {
    const payload = (event?.payload ?? {}) as ImportEurostatTourismNutsCachePayload
    // Same inert-when-unconfigured contract as the other cache importers —
    // the monthly cron (nuxt.config.ts) stays a no-op until an admin sets a
    // cache path from /settings, or a manual trigger passes one explicitly.
    if (!payload.cachePath?.trim() && !(await configuredCachePath())) {
      const skipped = `${EUROSTAT_TOURISM_NUTS_SOURCE_ID} has no configured cache path`
      await recordTaskRunStart('import-eurostat-tourism-nuts-cache')
      await recordTaskRunEnd('import-eurostat-tourism-nuts-cache', { error: skipped })
      return { result: { skipped } }
    }
    return await runExclusiveTask('import-eurostat-tourism-nuts-cache', async (signal) => {
      await recordTaskRunStart('import-eurostat-tourism-nuts-cache')
      try {
        const result = await runImportEurostatTourismNutsCache(payload, signal)
        throwIfTaskAborted(signal)
        await recordTaskRunEnd('import-eurostat-tourism-nuts-cache', {
          result: { regionCount: result.regionCount, regionsWithData: result.regionsWithData },
        })
        return { result }
      } catch (err) {
        await recordTaskRunEnd('import-eurostat-tourism-nuts-cache', { error: (err as Error).message })
        throw err
      }
    })
  },
})

export async function runImportEurostatTourismNutsCache(
  payload: ImportEurostatTourismNutsCachePayload = {},
  signal?: AbortSignal,
): Promise<ImportEurostatTourismNutsCacheSummary> {
  const cachePath = payload.cachePath?.trim() || (await configuredCachePath()) || DEFAULT_CACHE_PATH
  return await importEurostatTourismNutsCache({
    cachePath,
    generatedAt: payload.generatedAt,
    signal,
  })
}
