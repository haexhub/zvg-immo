// Flips the LLM kill switch. Admin-only via /api/settings/'s settings-auth
// guard. Takes effect on the next LLM call anywhere in the app — no
// redeploy, no running task restart needed.

import { getPool } from '~/server/utils/db'
import { setLlmKillSwitch } from '~/server/utils/app-settings'

export default defineEventHandler(async (event) => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  }
  const body = await readBody<Record<string, unknown>>(event).catch(() => undefined) ?? ({} as Record<string, unknown>)
  if (typeof body.enabled !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'enabled: ungültiger Wert.' })
  }
  await setLlmKillSwitch(db, body.enabled)
  return { enabled: body.enabled }
})
