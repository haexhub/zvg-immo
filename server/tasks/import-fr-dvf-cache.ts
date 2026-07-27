import { join } from 'node:path'
import { importDvfCsvFileToCache } from '~/server/utils/external-data/fr-dvf-cache'

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

export default defineTask({
  meta: {
    name: 'import-fr-dvf-cache',
    description: 'Import a French DVF CSV export into the local external-data market cache.',
  },
  async run(event) {
    return { result: await runImportFrDvfCache((event?.payload ?? {}) as ImportFrDvfCachePayload) }
  },
})

export async function runImportFrDvfCache(
  payload: ImportFrDvfCachePayload,
): Promise<ImportFrDvfCacheSummary> {
  const csvPath = requiredPath(payload.csvPath, 'csvPath')
  const cachePath = payload.cachePath?.trim() || DEFAULT_CACHE_PATH
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
