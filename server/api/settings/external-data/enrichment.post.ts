import {
  runExternalEnrichment,
  type ExternalEnrichmentOptions,
  type ExternalEnrichmentSummary,
} from '~/server/tasks/external-enrichment'

const MAX_LIMIT = 1000

export default defineEventHandler(async (event): Promise<ExternalEnrichmentSummary> => {
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({}) as Record<string, unknown>)
  const limit = optionalLimit(body.limit)
  return await runExternalEnrichment({ limit } satisfies ExternalEnrichmentOptions)
})

function optionalLimit(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw createError({ statusCode: 400, statusMessage: `limit: ganze Zahl zwischen 1 und ${MAX_LIMIT} erforderlich.` })
  }
  return value
}
