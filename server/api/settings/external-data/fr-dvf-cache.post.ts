import type {
  ImportFrDvfCachePayload,
  ImportFrDvfCacheSummary,
} from '~/server/tasks/import-fr-dvf-cache'

export default defineEventHandler(async (event): Promise<ImportFrDvfCacheSummary> => {
  const body = await readBody<Record<string, unknown>>(event).catch(() => undefined) ?? ({} as Record<string, unknown>)

  if (typeof body.csvPath !== 'string' || !body.csvPath.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'csvPath ist erforderlich.' })
  }

  // cachePath is deliberately not taken from the request, so a request body
  // cannot pick the file the import overwrites. csvPath stays: the admin
  // types the server-side CSV location in the card, and the response only
  // carries row counts, never file contents.
  const payload: ImportFrDvfCachePayload = {
    csvPath: body.csvPath,
    sourceVersion: typeof body.sourceVersion === 'string' && body.sourceVersion.trim() ? body.sourceVersion : undefined,
    generatedAt: typeof body.generatedAt === 'string' && body.generatedAt.trim() ? body.generatedAt : undefined,
  }

  const outcome = await runTask('import-fr-dvf-cache', { payload: { ...payload } }) as { result: ImportFrDvfCacheSummary }
  return outcome.result
})
