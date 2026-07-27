import {
  runImportEuFloodRiskCache,
  type ImportEuFloodRiskCachePayload,
  type ImportEuFloodRiskCacheTaskSummary,
} from '~/server/tasks/import-eu-flood-risk-cache'

const MAX_PAGE_SIZE = 10_000
const MAX_MAX_PAGES = 10_000

export default defineEventHandler(async (event): Promise<ImportEuFloodRiskCacheTaskSummary> => {
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({}) as Record<string, unknown>)

  const payload: ImportEuFloodRiskCachePayload = {
    cachePath: optionalString(body.cachePath),
    serviceUrl: optionalString(body.serviceUrl),
    sourceVersion: optionalString(body.sourceVersion),
    generatedAt: optionalString(body.generatedAt),
    pageSize: optionalInteger(body.pageSize, 'pageSize', 1, MAX_PAGE_SIZE),
    maxPages: optionalInteger(body.maxPages, 'maxPages', 1, MAX_MAX_PAGES),
    countryCodes: optionalCountryCodes(body.countryCodes),
  }

  return await runImportEuFloodRiskCache(payload)
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

function optionalCountryCodes(value: unknown): string[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !/^[a-z]{2}$/i.test(entry.trim()))) {
    throw createError({ statusCode: 400, statusMessage: 'countryCodes: ISO-2-Ländercodes erforderlich.' })
  }
  return value.map((entry) => entry.trim().toLowerCase())
}
