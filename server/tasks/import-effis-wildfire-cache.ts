import { join } from 'node:path'
import {
  EFFIS_WMS_URL,
  importEffisCurrentFireDangerCache,
  type EffisWmsSamplePoint,
} from '~/server/utils/external-data/effis-wildfire'

export interface ImportEffisWildfireCachePayload {
  cachePath?: string
  serviceUrl?: string
  sourceVersion?: string
  generatedAt?: string
  validFor?: string
  ttlHours?: number
  points?: EffisWmsSamplePoint[]
}

export interface ImportEffisWildfireCacheTaskSummary {
  cachePath: string
  serviceUrl: string
  sourceVersion: string
  generatedAt: string
  validFor: string
  requested: number
  sampled: number
}

const DEFAULT_CACHE_PATH = join(process.cwd(), '.cache_zvg', 'external', 'effis-wildfire.json')

export default defineTask({
  meta: {
    name: 'import-effis-wildfire-cache',
    description: 'Import Copernicus EFFIS ECMWF FWI WMS samples into the local wildfire hazard cache.',
  },
  async run(event) {
    return { result: await runImportEffisWildfireCache((event?.payload ?? {}) as ImportEffisWildfireCachePayload) }
  },
})

export async function runImportEffisWildfireCache(
  payload: ImportEffisWildfireCachePayload = {},
): Promise<ImportEffisWildfireCacheTaskSummary> {
  const generatedAt = payload.generatedAt ?? new Date().toISOString()
  const validFor = payload.validFor ?? generatedAt.slice(0, 10)
  const cachePath = payload.cachePath?.trim() || DEFAULT_CACHE_PATH
  const serviceUrl = payload.serviceUrl?.trim() || EFFIS_WMS_URL
  return await importEffisCurrentFireDangerCache({
    cachePath,
    serviceUrl,
    sourceVersion: payload.sourceVersion,
    generatedAt,
    validFor,
    ttlHours: payload.ttlHours,
    points: payload.points ?? [],
  })
}
