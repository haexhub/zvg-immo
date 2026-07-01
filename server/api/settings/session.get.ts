// Cheap "am I logged in?" probe used by the settings page on mount, so the
// UI can render the right initial view without a rejected request in the
// console. Public route — never leaks whether the cookie was valid vs
// missing beyond the boolean.

import { verifySession } from '../../utils/settings-auth'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig()
  const secret = String(config.settingsSessionSecret ?? '')
  if (!secret) return { authed: false }
  const cookie = getCookie(event, 'settings_session') ?? ''
  return { authed: verifySession(secret, cookie, Date.now()) }
})
