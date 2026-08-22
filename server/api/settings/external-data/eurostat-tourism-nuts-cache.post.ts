import type { ImportEurostatTourismNutsCachePayload } from '~/server/tasks/import-eurostat-tourism-nuts-cache'

// Detached, same reasoning as eu-flood-risk-cache/copernicus-effis-cache
// next to it: even a plain-fetch import can take a couple of seconds, and
// awaiting it here would make the button look hung. Progress/result surface
// through task-runs (eurostatTourismNutsImportStatus in
// /api/settings/llm-batch-jobs).
export default defineEventHandler(async (event): Promise<{ started: true }> => {
  const body = await readBody<Record<string, unknown>>(event).catch(() => undefined) ?? ({} as Record<string, unknown>)

  const payload: ImportEurostatTourismNutsCachePayload = {
    cachePath: optionalString(body.cachePath),
    generatedAt: optionalString(body.generatedAt),
  }

  void runTask('import-eurostat-tourism-nuts-cache', { payload: { ...payload } }).catch((err: unknown) => {
    console.error('[settings/external-data/eurostat-tourism-nuts-cache] trigger failed:', (err as Error).message)
  })
  return { started: true }
})

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
