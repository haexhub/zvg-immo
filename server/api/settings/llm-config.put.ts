// Updates the LLM max-output-tokens limits. Admin-only via /api/settings/'s
// settings-auth guard. Values are clamped server-side (setLlmMaxTokens) so a
// dashboard typo can't silence every LLM call or blow up cost.

import { getPool } from '../../utils/db'
import { getAllLlmMaxTokens, setLlmMaxTokens, type LlmMaxTokensKind } from '../../utils/app-settings'

const KINDS: LlmMaxTokensKind[] = ['extraction', 'summary', 'translation']

export default defineEventHandler(async (event): Promise<Record<LlmMaxTokensKind, number>> => {
  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  }
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({}) as Record<string, unknown>)
  for (const kind of KINDS) {
    const value = body[kind]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw createError({ statusCode: 400, statusMessage: `${kind}: ungültiger Wert.` })
    }
    await setLlmMaxTokens(db, kind, value)
  }
  return await getAllLlmMaxTokens(db)
})
