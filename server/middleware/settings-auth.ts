// Guards every /api/settings/* route against unauthenticated access. The
// login and session-probe endpoints are excluded — they're what the UI hits
// to establish or check the session.
//
// On success, refreshes the cookie's expiry (sliding-window 24h) so an active
// user doesn't get logged out mid-flow.

import { signSession, verifySession } from '../utils/settings-auth'

const SESSION_COOKIE = 'settings_session'
const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const PUBLIC_PATHS = new Set([
  '/api/settings/login',
  '/api/settings/session',
])

export default defineEventHandler((event) => {
  const url = event.node.req.url ?? ''
  // Strip query string so a `?foo=bar` doesn't bypass the whitelist. Decode
  // and lowercase so encoded or differently-cased variants can't slip past
  // the prefix check — the guard must not depend on how the router happens
  // to normalize paths. Malformed encoding keeps the raw path (fail closed).
  let path = url.split('?')[0]!
  try {
    path = decodeURIComponent(path)
  } catch {
    // keep raw path
  }
  path = path.toLowerCase()
  if (!path.startsWith('/api/settings/')) return
  if (PUBLIC_PATHS.has(path)) return

  const config = useRuntimeConfig()
  const secret = String(config.settingsSessionSecret ?? '')
  if (!secret) {
    throw createError({ statusCode: 503, statusMessage: 'Settings are not configured on this server.' })
  }
  const cookie = getCookie(event, SESSION_COOKIE) ?? ''
  const now = Date.now()
  if (!verifySession(secret, cookie, now)) {
    throw createError({ statusCode: 401, statusMessage: 'Not authenticated.' })
  }

  // Refresh the cookie on every request so an active user doesn't get
  // logged out mid-flow.
  const expiry = now + SESSION_TTL_MS
  setCookie(event, SESSION_COOKIE, signSession(secret, expiry), {
    httpOnly: true,
    secure: !import.meta.dev,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
})
