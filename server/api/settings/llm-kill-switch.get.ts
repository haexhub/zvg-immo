// Current state of the LLM kill switch for the /settings "KI/LLM" section.
// Lives under /api/settings/ and therefore automatically inherits
// server/middleware/settings-auth.ts's guard.

import { getPool } from '~/server/utils/db'
import { DEFAULT_LLM_KILL_SWITCH, readLlmKillSwitch } from '~/server/utils/app-settings'

// Reads without getLlmKillSwitch's fail-closed fallback: that fallback belongs
// to the LLM resolvers, here it would show a switch the admin never set and
// hide the DB error.
export default defineEventHandler(async () => {
  const db = getPool()
  if (!db) return { enabled: DEFAULT_LLM_KILL_SWITCH }
  const enabled = await readLlmKillSwitch(db).catch((error: unknown) => {
    console.warn('[llm-kill-switch] status read failed', error)
    throw createError({ statusCode: 503, statusMessage: 'LLM-Kill-Switch konnte nicht gelesen werden.', cause: error })
  })
  return { enabled }
})
