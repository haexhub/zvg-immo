// Password-based login for the /settings page. Timing-safe compare against the
// SETTINGS_PASSWORD env var; on match, drops an HMAC-signed session cookie.
// Rate-limits to 5 failed attempts per IP per 60s to blunt brute-force.

import {
  checkRateLimit,
  recordFailedAttempt,
  signSession,
  timingSafePasswordEqual,
} from '../../utils/settings-auth'

const SESSION_COOKIE = 'settings_session'
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

function clientIp(event: ReturnType<typeof getRequestHeaders> extends infer _ ? any : never): string {
  // Traefik sets x-forwarded-for. Fall back to remote address for local dev.
  const fwd = getRequestHeader(event, 'x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim()
  return event.node.req.socket?.remoteAddress ?? 'unknown'
}

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

  const ip = clientIp(event)
  const now = Date.now()
  if (!checkRateLimit(ip, now)) {
    throw createError({
      statusCode: 429,
      statusMessage: 'Zu viele Fehlversuche. Bitte 60 Sekunden warten.',
    })
  }

  const body = await readBody<{ password?: unknown }>(event).catch(
    () => ({} as { password?: unknown }),
  )
  const submitted = typeof body.password === 'string' ? body.password : ''
  if (!timingSafePasswordEqual(submitted, password)) {
    recordFailedAttempt(ip, now)
    throw createError({ statusCode: 401, statusMessage: 'Falsches Passwort.' })
  }

  const expiry = now + SESSION_TTL_MS
  setCookie(event, SESSION_COOKIE, signSession(secret, expiry), {
    httpOnly: true,
    secure: !import.meta.dev,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
  return { ok: true }
})
