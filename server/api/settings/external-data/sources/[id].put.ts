// Saves one external-data source's config fields (sources.ts's configFields)
// as a DB override — generic across every configurable source, same PUT
// route regardless of which fields that source declares. An omitted or
// empty field clears its override and falls back to env/default (see
// server/utils/external-data/config.ts's coerceFieldValue). Admin-only via
// /api/settings/'s settings-auth guard.

import { getPool } from '~/server/utils/db'
import { getConfigurableExternalDataSource, setStoredExternalDataSourceConfig } from '~/server/utils/external-data/config'

export default defineEventHandler(async (event) => {
  const id = String(event.context.params?.id ?? '')
  const source = getConfigurableExternalDataSource(id)
  if (!source) {
    throw createError({ statusCode: 404, statusMessage: `unbekannte externe Quelle: ${id}` })
  }
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  }
  const body = await readBody<Record<string, unknown>>(event).catch(() => {
    throw createError({ statusCode: 400, statusMessage: 'Ungültiger Request-Body.' })
  })
  const saved = await setStoredExternalDataSourceConfig(db, id, body ?? {})
  return { id, values: saved }
})
