import {
  runImportCopernicusEffisCache,
  type ImportCopernicusEffisCachePayload,
  type ImportCopernicusEffisCacheTaskSummary,
} from '~/server/tasks/import-copernicus-effis-cache'

const MAX_PAGE_SIZE = 10_000
const MAX_MAX_PAGES = 10_000

export default defineEventHandler(async (event): Promise<ImportCopernicusEffisCacheTaskSummary> => {
  const body = await readBody<Record<string, unknown>>(event).catch(() => undefined) ?? ({} as Record<string, unknown>)

  const payload: ImportCopernicusEffisCachePayload = {
    cachePath: optionalString(body.cachePath),
    serviceUrl: optionalString(body.serviceUrl),
    sourceVersion: optionalString(body.sourceVersion),
    generatedAt: optionalString(body.generatedAt),
    bbox: optionalBbox(body.bbox),
    pageSize: optionalInteger(body.pageSize, 'pageSize', 1, MAX_PAGE_SIZE),
    maxPages: optionalInteger(body.maxPages, 'maxPages', 1, MAX_MAX_PAGES),
  }

  return await runImportCopernicusEffisCache(payload)
})

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function optionalInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw createError({ statusCode: 400, statusMessage: `${label}: ganze Zahl zwischen ${min} und ${max} erforderlich.` })
  }
  return value
}

function optionalBbox(value: unknown): [number, number, number, number] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.length !== 4 || value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw createError({ statusCode: 400, statusMessage: 'bbox: [minLng, minLat, maxLng, maxLat] mit vier Zahlen erforderlich.' })
  }
  return value as [number, number, number, number]
}
