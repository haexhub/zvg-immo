import {
  runImportFrDvfCache,
  type ImportFrDvfCachePayload,
  type ImportFrDvfCacheSummary,
} from '~/server/tasks/import-fr-dvf-cache'

export default defineEventHandler(async (event): Promise<ImportFrDvfCacheSummary> => {
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({}) as Record<string, unknown>)

  if (typeof body.csvPath !== 'string' || !body.csvPath.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'csvPath ist erforderlich.' })
  }

  const payload: ImportFrDvfCachePayload = {
    csvPath: body.csvPath,
    cachePath: typeof body.cachePath === 'string' && body.cachePath.trim() ? body.cachePath : undefined,
    sourceVersion: typeof body.sourceVersion === 'string' && body.sourceVersion.trim() ? body.sourceVersion : undefined,
    generatedAt: typeof body.generatedAt === 'string' && body.generatedAt.trim() ? body.generatedAt : undefined,
  }

  return await runImportFrDvfCache(payload)
})
