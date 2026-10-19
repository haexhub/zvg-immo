// Guards /api/saved-searches/*, /api/watchlist/*, /api/alerts/*,
// /api/lawyer-inquiries/* and /api/api-keys/*. Modeled on
// server/middleware/settings-auth.ts but per-user instead of a shared secret:
// verifies the caller's Supabase access token and sets event.context.user,
// 401s otherwise. Unrelated routes (/api/auctions, /api/settings/*,
// /api/lawyers, /api/data/* — guarded separately by
// server/middleware/data-api-auth.ts — ...) are untouched — /api/lawyers.get.ts
// is intentionally public (catalog browsing needs no login, only sending an
// inquiry does).

import { guardedRequestPath } from '../utils/request-path'
import { getUserFromEvent } from '../utils/supabase'

const GUARDED_PREFIXES = [
  '/api/saved-searches/',
  '/api/watchlist/',
  '/api/alerts/',
  '/api/lawyer-inquiries/',
  '/api/api-keys/',
]

export default defineEventHandler(async (event) => {
  const path = guardedRequestPath(event.node.req.url)
  // Guard both the collection routes (e.g. `/api/saved-searches`, no
  // trailing slash) and their sub-paths (`/api/saved-searches/<id>`).
  if (!GUARDED_PREFIXES.some((p) => path === p.slice(0, -1) || path.startsWith(p))) return

  const user = await getUserFromEvent(event)
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: 'Not authenticated.' })
  }
  event.context.user = user
})
