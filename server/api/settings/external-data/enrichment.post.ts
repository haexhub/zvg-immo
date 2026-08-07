import type { ExternalEnrichmentOptions } from '~/server/tasks/external-enrichment'

const MAX_LIMIT = 1000

// Detached on purpose: an unscoped run sweeps every auction across every
// country, calling several external providers per auction — far longer than
// a request can stay open. Progress/result surface through task-runs
// (externalEnrichmentStatus in /api/settings/llm-batch-jobs), same as the
// country enrich flow's detached reprocess/external-enrichment calls.
export default defineEventHandler(async (event): Promise<{ started: true }> => {
  // Der Button schickt POST ohne Body: readBody wirft dann nicht, sondern
  // liefert undefined (kein content-length -> h3 liest gar nicht erst) — der
  // catch allein deckt das nicht ab, ein Property-Zugriff darauf wird zu 500.
  const body = await readBody<Record<string, unknown>>(event).catch(() => undefined) ?? {}
  const limit = optionalLimit(body.limit)
  const country = optionalToken(body.country, 'country')
  const platform = optionalToken(body.platform, 'platform')
  const externalId = optionalToken(body.externalId, 'externalId')
  void runTask('external-enrichment', {
    payload: { limit, country, platform, externalId } satisfies ExternalEnrichmentOptions,
  }).catch((err: unknown) => {
    console.error('[settings/external-data/enrichment] trigger failed:', (err as Error).message)
  })
  return { started: true }
})

function optionalLimit(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw createError({ statusCode: 400, statusMessage: `limit: ganze Zahl zwischen 1 und ${MAX_LIMIT} erforderlich.` })
  }
  return value
}

function optionalToken(value: unknown, field: string): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string') {
    throw createError({ statusCode: 400, statusMessage: `${field}: Text erforderlich.` })
  }
  const trimmed = value.trim()
  return trimmed || undefined
}
