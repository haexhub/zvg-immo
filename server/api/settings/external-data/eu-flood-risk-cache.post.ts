import type { ImportEuFloodRiskCachePayload } from '~/server/tasks/import-eu-flood-risk-cache'

const MAX_PAGE_SIZE = 10_000
const MAX_MAX_PAGES = 10_000

// Detached, like copernicus-effis-cache next to it: paginating the EEA layer
// takes minutes even country-scoped, and awaiting it here is what made this
// button look like it did nothing (measured 2026-08-11: the unfiltered layer
// pulled 542 MB in 158 s). Progress/result surface through task-runs
// (euFloodRiskImportStatus in /api/settings/llm-batch-jobs).
export default defineEventHandler(async (event): Promise<{ started: true }> => {
  const body = await readBody<Record<string, unknown>>(event).catch(() => undefined) ?? ({} as Record<string, unknown>)

  const payload: ImportEuFloodRiskCachePayload = {
    cachePath: optionalString(body.cachePath),
    serviceUrl: optionalString(body.serviceUrl),
    sourceVersion: optionalString(body.sourceVersion),
    generatedAt: optionalString(body.generatedAt),
    pageSize: optionalInteger(body.pageSize, 'pageSize', 1, MAX_PAGE_SIZE),
    maxPages: optionalInteger(body.maxPages, 'maxPages', 1, MAX_MAX_PAGES),
    countryCodes: optionalCountryCodes(body.countryCodes),
  }

  void runTask('import-eu-flood-risk-cache', { payload: { ...payload } }).catch((err: unknown) => {
    console.error('[settings/external-data/eu-flood-risk-cache] trigger failed:', (err as Error).message)
  })
  return { started: true }
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
