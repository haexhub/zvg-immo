import {
  runImportEffisWildfireCache,
  type ImportEffisWildfireCachePayload,
  type ImportEffisWildfireCacheTaskSummary,
} from '~/server/tasks/import-effis-wildfire-cache'

const MAX_POINTS = 5_000
const MAX_TTL_HOURS = 168

export default defineEventHandler(async (event): Promise<ImportEffisWildfireCacheTaskSummary> => {
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({}) as Record<string, unknown>)

  const payload: ImportEffisWildfireCachePayload = {
    cachePath: optionalString(body.cachePath),
    serviceUrl: optionalString(body.serviceUrl),
    sourceVersion: optionalString(body.sourceVersion),
    generatedAt: optionalString(body.generatedAt),
    validFor: optionalDate(body.validFor),
    ttlHours: optionalInteger(body.ttlHours, 'ttlHours', 1, MAX_TTL_HOURS),
    points: optionalPoints(body.points),
  }

  return await runImportEffisWildfireCache(payload)
})

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function optionalDate(value: unknown): string | undefined {
  const raw = optionalString(value)
  if (!raw) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw createError({ statusCode: 400, statusMessage: 'validFor: Datum im Format YYYY-MM-DD erforderlich.' })
  }
  return raw
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

function optionalPoints(value: unknown): ImportEffisWildfireCachePayload['points'] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_POINTS) {
    throw createError({ statusCode: 400, statusMessage: `points: maximal ${MAX_POINTS} Koordinaten erforderlich.` })
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw createError({ statusCode: 400, statusMessage: 'points: Objekte mit lat/lng erforderlich.' })
    }
    const candidate = entry as Record<string, unknown>
    const lat = candidate.lat
    const lng = candidate.lng
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw createError({ statusCode: 400, statusMessage: 'points.lat: Zahl zwischen -90 und 90 erforderlich.' })
    }
    if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw createError({ statusCode: 400, statusMessage: 'points.lng: Zahl zwischen -180 und 180 erforderlich.' })
    }
    return {
      id: optionalString(candidate.id),
      lat,
      lng,
    }
  })
}
