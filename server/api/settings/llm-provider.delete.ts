// Clears the LLM provider override, reverting to the ENV-configured
// (nuxt.config.ts extractLlm.*) provider. Admin-only via /api/settings/'s
// settings-auth guard.

import { getPool } from '~/server/utils/db'
import { clearLlmProviderOverride } from '~/server/utils/app-settings'

export default defineEventHandler(async () => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  }
  await clearLlmProviderOverride(db)
  return { cleared: true }
})
