import { join } from 'node:path'
import { importDvfCsvFileToCache } from '~/server/utils/external-data/fr-dvf-cache'
import { runExclusiveTask, throwIfTaskAborted } from '~/server/utils/exclusive-task'

export interface ImportFrDvfCachePayload {
  csvPath?: string
  cachePath?: string
  sourceVersion?: string
  generatedAt?: string
}

export interface ImportFrDvfCacheSummary {
  csvPath: string
  cachePath: string
  sourceVersion: string
  rows: number
  normalized: number
  dropped: number
  generatedAt: string
}

const DEFAULT_CACHE_PATH = join(process.cwd(), '.cache_zvg', 'external', 'fr-dvf.json')

// The market adapter reads the cachePath resolved for fr-dvf-geolocated (DB
// override from /settings > env runtimeConfig > field default), and /settings
// only sends a csvPath — so the import must write to that same path instead of
// DEFAULT_CACHE_PATH, where nothing reads it. Same contract as
// import-eu-flood-risk-cache.ts's configuredCachePath().
async function configuredCachePath(): Promise<string | null> {
  // Dynamic imports so tests passing an explicit cachePath never load the pg
  // pool or the adapter wiring.
  const { getPool } = await import('~/server/utils/db')
  const { resolvedSourceValues } = await import('../utils/tasks/external-enrichment-adapters')
  const values = await resolvedSourceValues(getPool(), 'fr-dvf-geolocated')
  return values ? String(values.cachePath) : null
}

export default defineTask({
  meta: {
    name: 'import-fr-dvf-cache',
    description: 'Import a French DVF CSV export into the local external-data market cache.',
  },
  async run(event) {
    return await runExclusiveTask('import-fr-dvf-cache', async (signal) => {
      const result = await runImportFrDvfCache((event?.payload ?? {}) as ImportFrDvfCachePayload)
      throwIfTaskAborted(signal)
      return { result }
    })
  },
})

export async function runImportFrDvfCache(
  payload: ImportFrDvfCachePayload,
): Promise<ImportFrDvfCacheSummary> {
  const csvPath = requiredPath(payload.csvPath, 'csvPath')
  const cachePath = payload.cachePath?.trim() || (await configuredCachePath()) || DEFAULT_CACHE_PATH
  const generatedAt = payload.generatedAt ?? new Date().toISOString()
  const sourceVersion = payload.sourceVersion?.trim() || defaultSourceVersion(generatedAt)

  const { load, cache } = await importDvfCsvFileToCache({
    csvPath,
    cachePath,
    sourceVersion,
    generatedAt,
  })

  return {
    csvPath,
    cachePath,
    sourceVersion: cache.sourceVersion,
    rows: load.rows,
    normalized: load.normalized,
    dropped: load.dropped,
    generatedAt: cache.generatedAt,
  }
}

function requiredPath(value: string | undefined, label: string): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new Error(`${label} is required`)
  }
  return trimmed
}

function defaultSourceVersion(generatedAt: string): string {
  return `fr-dvf-${generatedAt.slice(0, 10)}`
}
