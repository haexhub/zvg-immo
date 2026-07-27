import {
  runExternalEnrichment,
  type ExternalEnrichmentOptions,
  type ExternalEnrichmentSummary,
} from '~/server/tasks/external-enrichment'

const MAX_LIMIT = 1000
const MAX_RATE_LIMIT_MS = 60_000

export default defineEventHandler(async (event): Promise<ExternalEnrichmentSummary> => {
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({}) as Record<string, unknown>)
  const limit = optionalLimit(body.limit)
  const providerRateLimits = optionalProviderRateLimits(body.providerRateLimits)
  return await runExternalEnrichment({ limit, providerRateLimits } satisfies ExternalEnrichmentOptions)
})

function optionalLimit(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw createError({ statusCode: 400, statusMessage: `limit: ganze Zahl zwischen 1 und ${MAX_LIMIT} erforderlich.` })
  }
  return value
}

function optionalProviderRateLimits(value: unknown): Record<string, number> | undefined {
  if (value == null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createError({ statusCode: 400, statusMessage: 'providerRateLimits: Objekt mit Provider-IDs erforderlich.' })
  }
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[\w.:-]+$/.test(key)) {
      throw createError({ statusCode: 400, statusMessage: 'providerRateLimits: ungültige Provider-ID.' })
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_RATE_LIMIT_MS) {
      throw createError({ statusCode: 400, statusMessage: `providerRateLimits.${key}: ganze Zahl zwischen 0 und ${MAX_RATE_LIMIT_MS} erforderlich.` })
    }
    out[key] = raw
  }
  return out
}
