// Current LLM max-output-tokens limits for the /settings "LLM-Konfiguration"
// section. Lives under /api/settings/ and therefore automatically inherits
// server/middleware/settings-auth.ts's guard — no separate auth check here.

import { getPool } from '../../utils/db'
import { DEFAULT_LLM_MAX_TOKENS, getAllLlmMaxTokens, type LlmMaxTokensKind } from '../../utils/app-settings'

export default defineEventHandler(async (): Promise<Record<LlmMaxTokensKind, number>> => {
  const db = getPool()
  return db ? await getAllLlmMaxTokens(db) : DEFAULT_LLM_MAX_TOKENS
})
