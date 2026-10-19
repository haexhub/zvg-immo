// Guards every /api/settings/* route against unauthenticated access. The
// login and session-probe endpoints are excluded — they're what the UI hits
// to establish or check the session.
//
// On success, refreshes the cookie's expiry (sliding-window 24h) so an active
// user doesn't get logged out mid-flow. The original issue time is carried
// forward, so the refresh never extends a session past SESSION_MAX_AGE_MS.

import { guardedRequestPath } from '../utils/request-path'
import { currentSessionSigningKey, signSession, verifySession } from '../utils/settings-auth'

const SESSION_COOKIE = 'settings_session'
const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const PUBLIC_PATHS = new Set([
  '/api/settings/login',
  '/api/settings/session',
])

export default defineEventHandler(async (event) => {
  const path = guardedRequestPath(event.node.req.url)
  if (!path.startsWith('/api/settings/')) return
  if (PUBLIC_PATHS.has(path)) return

  const config = useRuntimeConfig()
  const secret = String(config.settingsSessionSecret ?? '')
  const password = String(config.settingsPassword ?? '')
  if (!secret || !password) {
    throw createError({ statusCode: 503, statusMessage: 'Settings are not configured on this server.' })
  }
  const now = Date.now()
  // Fail closed: without the current session epoch a logged-out cookie could
  // not be told apart from a live one.
  const key = await currentSessionSigningKey(secret, password, now).catch((error: unknown) => {
    console.warn('[settings-auth] session epoch read failed', error)
    throw createError({ statusCode: 503, statusMessage: 'Settings session store unavailable.', cause: error })
  })
  const cookie = getCookie(event, SESSION_COOKIE) ?? ''
  const issuedAt = verifySession(key, cookie, now)
  if (issuedAt === null) {
    throw createError({ statusCode: 401, statusMessage: 'Not authenticated.' })
  }

  // Refresh the cookie on every request so an active user doesn't get
  // logged out mid-flow.
  const expiry = now + SESSION_TTL_MS
  setCookie(event, SESSION_COOKIE, signSession(key, issuedAt, expiry), {
    httpOnly: true,
    secure: !import.meta.dev,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
})
