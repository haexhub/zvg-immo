// Rotates the session epoch so every settings cookie issued so far — on any
// device, including a stolen copy — stops verifying, then clears the
// caller's cookie. Guarded by the settings-auth middleware like every
// non-public /api/settings/* route.

import { getPool } from '../../utils/db'
import { rotateSessionEpoch } from '../../utils/settings-auth'

export default defineEventHandler(async (event) => {
  deleteCookie(event, 'settings_session', { path: '/' })
  const db = getPool()
  if (db) {
    await rotateSessionEpoch(db, Date.now()).catch((error: unknown) => {
      console.warn('[settings-logout] session epoch rotation failed', error)
      throw createError({ statusCode: 503, statusMessage: 'Abmelden fehlgeschlagen: Sitzungen konnten nicht widerrufen werden.', cause: error })
    })
  }
  return { ok: true }
})
