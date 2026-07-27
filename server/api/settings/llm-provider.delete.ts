// Clears the LLM provider override, reverting to the ENV-configured
// (nuxt.config.ts extractLlm.*) provider. Admin-only via /api/settings/'s
// settings-auth guard.

import type { H3Event } from 'h3'
import { getPool } from '~/server/utils/db'
import { clearLlmProviderOverride, type LlmProviderScope } from '~/server/utils/app-settings'

function readScope(event: H3Event): LlmProviderScope {
  return getQuery(event).scope === 'translation' ? 'translation' : 'extraction'
}

export default defineEventHandler(async (event) => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  }
  await clearLlmProviderOverride(db, readScope(event))
  return { cleared: true }
})
