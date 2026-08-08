import type { ImportCopernicusEffisCachePayload } from '~/server/tasks/import-copernicus-effis-cache'

const MAX_PAGE_SIZE = 10_000
const MAX_MAX_PAGES = 10_000

// Detached, unlike the eu-flood-risk-cache/fr-dvf-cache imports next to it:
// EFFIS's WFS dataset is two orders of magnitude bigger (100k+ features,
// ~100 paginated requests measured live 2026-08-08) — a synchronous request
// just times out with nothing to show for it, which is exactly what made
// this button look like it had no effect. Progress/result surface through
// task-runs (copernicusEffisImportStatus in /api/settings/llm-batch-jobs),
// same as the external-enrichment sweep this app_settings already tracks.
export default defineEventHandler(async (event): Promise<{ started: true }> => {
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

  void runTask('import-copernicus-effis-cache', { payload: { ...payload } }).catch((err: unknown) => {
    console.error('[settings/external-data/copernicus-effis-cache] trigger failed:', (err as Error).message)
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

function optionalBbox(value: unknown): [number, number, number, number] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.length !== 4 || value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw createError({ statusCode: 400, statusMessage: 'bbox: [minLng, minLat, maxLng, maxLat] mit vier Zahlen erforderlich.' })
  }
  return value as [number, number, number, number]
}
