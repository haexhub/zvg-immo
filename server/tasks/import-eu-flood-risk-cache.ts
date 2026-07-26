import { join } from 'node:path'
import {
  EU_FLOOD_RISK_POLYGON_LAYER_URL,
  EU_FLOOD_RISK_SOURCE_VERSION,
  importEuFloodRiskGeoJsonCache,
} from '~/server/utils/external-data/eu-flood-risk'

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

export default defineTask({
  meta: {
    name: 'import-eu-flood-risk-cache',
    description: 'Import EU Flood Risk Areas polygons into the local external-data hazard cache.',
  },
  async run(event) {
    return { result: await runImportEuFloodRiskCache((event?.payload ?? {}) as ImportEuFloodRiskCachePayload) }
  },
})

export async function runImportEuFloodRiskCache(
  payload: ImportEuFloodRiskCachePayload = {},
): Promise<ImportEuFloodRiskCacheTaskSummary> {
  const generatedAt = payload.generatedAt ?? new Date().toISOString()
  const sourceVersion = payload.sourceVersion?.trim() || EU_FLOOD_RISK_SOURCE_VERSION
  const cachePath = payload.cachePath?.trim() || DEFAULT_CACHE_PATH
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
