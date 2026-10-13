// Cheap "am I logged in?" probe used by the settings page on mount, so the
// UI can render the right initial view without a rejected request in the
// console. Public route — never leaks whether the cookie was valid vs
// missing beyond the boolean.

import { currentSessionSigningKey, verifySession } from '../../utils/settings-auth'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const secret = String(config.settingsSessionSecret ?? '')
  const password = String(config.settingsPassword ?? '')
  if (!secret || !password) return { authed: false }
  const cookie = getCookie(event, 'settings_session') ?? ''
  const now = Date.now()
  return { authed: verifySession(await currentSessionSigningKey(secret, password, now), cookie, now) !== null }
})
