// Saves which reusable LLM provider profile is assigned to which use case
// (Dokument-Extraktion / Text-Übersetzung). Independent from the profile
// list itself — see PUT /api/settings/llm-profiles.

import { getPool } from '~/server/utils/db'
import { setLlmProviderAssignments, type LlmProviderAssignments } from '~/server/utils/app-settings'

export default defineEventHandler(async (event) => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  }
  const body = await readBody<Record<string, unknown>>(event).catch(() => {
    throw createError({ statusCode: 400, statusMessage: 'Ungültiger Request-Body.' })
  })
  const assignments = (body?.assignments && typeof body.assignments === 'object'
    ? body.assignments
    : {}) as LlmProviderAssignments
  try {
    return await setLlmProviderAssignments(db, assignments, body?.strategy)
  } catch (err) {
    console.warn(`[settings/llm-assignments] save failed: ${(err as Error).message}`)
    throw createError({
      statusCode: 500,
      statusMessage: 'Zuordnung konnte nicht gespeichert werden.',
    })
  }
})
