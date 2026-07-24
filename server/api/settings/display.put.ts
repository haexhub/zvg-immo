// Updates the dashboard display defaults. Admin-only via /api/settings/'s
// settings-auth guard.

import { getPool } from '~/server/utils/db'
import { setHideRulesOnlyAuctions } from '~/server/utils/app-settings'

export default defineEventHandler(async (event) => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  }
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({}) as Record<string, unknown>)
  if (typeof body.hideRulesOnlyAuctions !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'hideRulesOnlyAuctions: ungültiger Wert.' })
  }
  await setHideRulesOnlyAuctions(db, body.hideRulesOnlyAuctions)
  return { hideRulesOnlyAuctions: body.hideRulesOnlyAuctions }
})
