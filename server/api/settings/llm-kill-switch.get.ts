// Current state of the LLM kill switch for the /settings "KI/LLM" section.
// Lives under /api/settings/ and therefore automatically inherits
// server/middleware/settings-auth.ts's guard.

import { getPool } from '~/server/utils/db'
import { DEFAULT_LLM_KILL_SWITCH, getLlmKillSwitch } from '~/server/utils/app-settings'

export default defineEventHandler(async () => {
  const db = getPool()
  return {
    enabled: db ? await getLlmKillSwitch(db) : DEFAULT_LLM_KILL_SWITCH,
  }
})
