// Clears the LLM provider override, reverting to the ENV-configured
// (nuxt.config.ts extractLlm.*) provider. Admin-only via /api/settings/'s
// settings-auth guard.

import { getPool } from '~/server/utils/db'
import { clearLlmProviderOverride } from '~/server/utils/app-settings'
import { readLlmProviderScope } from '~/server/utils/llm-provider-scope'

export default defineEventHandler(async (event) => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  }
  await clearLlmProviderOverride(db, readLlmProviderScope(event))
  return { cleared: true }
})
