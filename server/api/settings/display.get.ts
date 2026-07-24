// Current dashboard display defaults for the /settings "LLM-Konfiguration"
// section. Lives under /api/settings/ and therefore automatically inherits
// server/middleware/settings-auth.ts's guard.

import { getPool } from '~/server/utils/db'
import { DEFAULT_HIDE_RULES_ONLY_AUCTIONS, getHideRulesOnlyAuctions } from '~/server/utils/app-settings'

export default defineEventHandler(async () => {
  const db = getPool()
  return {
    hideRulesOnlyAuctions: db ? await getHideRulesOnlyAuctions(db) : DEFAULT_HIDE_RULES_ONLY_AUCTIONS,
  }
})
