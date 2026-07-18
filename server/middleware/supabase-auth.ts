// Guards /api/saved-searches/*, /api/watchlist/* and /api/alerts/* (Phase 3
// adds alerts; lawyers/api-keys come later, in their own worktrees, and add
// their own prefixes here then). Modeled on server/middleware/settings-auth.ts
// but per-user instead of a shared secret: verifies the caller's Supabase
// access token and sets event.context.user, 401s otherwise. Unrelated routes
// (/api/auctions, /api/settings/*, ...) are untouched.

import { getUserFromEvent } from '../utils/supabase'

const GUARDED_PREFIXES = ['/api/saved-searches/', '/api/watchlist/', '/api/alerts/']

export default defineEventHandler(async (event) => {
  let path = (event.node.req.url ?? '').split('?')[0]!
  try {
    path = decodeURIComponent(path)
  } catch {
    // keep raw path
  }
  path = path.toLowerCase()
  // Guard both the collection routes (e.g. `/api/saved-searches`, no
  // trailing slash) and their sub-paths (`/api/saved-searches/<id>`).
  if (!GUARDED_PREFIXES.some((p) => path === p.slice(0, -1) || path.startsWith(p))) return

  const user = await getUserFromEvent(event)
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: 'Not authenticated.' })
  }
  event.context.user = user
})
