// Password-based login for the /settings page. Timing-safe compare against the
// SETTINGS_PASSWORD env var; on match, drops an HMAC-signed session cookie.
// Rate-limits to 5 failed attempts per IP per 60s to blunt brute-force.

import {
  checkRateLimit,
  currentSessionSigningKey,
  recordFailedAttempt,
  signSession,
  timingSafePasswordEqual,
} from '../../utils/settings-auth'
import { requestClientIp } from '../../utils/request-client-ip'

const SESSION_COOKIE = 'settings_session'
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const password = String(config.settingsPassword ?? '')
  const secret = String(config.settingsSessionSecret ?? '')
  if (!password || !secret) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Settings are not configured on this server.',
    })
  }

  const ip = requestClientIp(event)
  const body = await readBody<{ password?: unknown }>(event).catch(
    () => undefined,
  ) ?? ({} as { password?: unknown })

  // Check and record must stay in one synchronous stretch with no await in
  // between: otherwise a burst of parallel requests all pass the check while
  // the first ones are still reading their body, and the limit only counts
  // sequential attempts.
  const now = Date.now()
  if (!checkRateLimit(ip, now)) {
    throw createError({
      statusCode: 429,
      statusMessage: 'Zu viele Fehlversuche. Bitte 60 Sekunden warten.',
    })
  }
  const submitted = typeof body.password === 'string' ? body.password : ''
  if (!timingSafePasswordEqual(submitted, password)) {
    recordFailedAttempt(ip, now)
    throw createError({ statusCode: 401, statusMessage: 'Falsches Passwort.' })
  }

  // Only reached after the password matched, so this await cannot split the
  // rate-limit check from its record above.
  const key = await currentSessionSigningKey(secret, password, now)
  const expiry = now + SESSION_TTL_MS
  setCookie(event, SESSION_COOKIE, signSession(key, now, expiry), {
    httpOnly: true,
    secure: !import.meta.dev,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
  return { ok: true }
})
