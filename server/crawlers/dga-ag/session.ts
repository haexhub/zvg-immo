import { load } from 'cheerio'
import { BASE_URL, UA } from './constants'

const LOGIN_PAGE_URL = `${BASE_URL}/login.html`
const FETCH_TIMEOUT_MS = 20_000
/** No documented felogin session lifetime — this is just a cheap upper bound
 *  so a full crawl doesn't re-login before every single detail fetch. A
 *  session that expired earlier makes the detail page redirect back to
 *  /login.html instead of erroring; detail.ts detects that and forces a
 *  fresh login rather than relying on this TTL being exactly right. */
const SESSION_MAX_AGE_MS = 20 * 60_000

interface DgaAgCredentials {
  username: string
  password: string
}

function getCredentials(): DgaAgCredentials | null {
  const config = useRuntimeConfig().dgaAg as { username?: string; password?: string } | undefined
  const username = config?.username?.trim()
  const password = config?.password
  if (!username || !password) return null
  return { username, password }
}

function joinSetCookies(res: Response): string {
  return (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ')
}

/**
 * TYPO3 felogin (`/login.html`) renders a fresh CSRF token + nonce cookie on
 * every GET; both must be echoed back together with the credentials on the
 * POST, or the login silently re-renders the same form. Structurally
 * identical to cz/list.ts's establishSession() and lv/list.ts's
 * establishFilterSession() — no shared cookie-jar utility exists project-wide.
 */
async function login(creds: DgaAgCredentials): Promise<string> {
  const getRes = await fetch(LOGIN_PAGE_URL, {
    headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'de-DE,de;q=0.9' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!getRes.ok) throw new Error(`dga-ag.de login page HTTP ${getRes.status}`)
  const nonceCookie = joinSetCookies(getRes)
  const html = await getRes.text()

  const $ = load(html)
  const form = $('form[action*="tx_felogin_login"]').first()
  const actionPath = form.attr('action')
  if (!actionPath || !nonceCookie) throw new Error('dga-ag.de login form or nonce cookie missing')

  const body = new URLSearchParams()
  form.find('input[type="hidden"], input[type="submit"]').each((_i, el) => {
    const name = $(el).attr('name')
    if (!name) return
    body.set(name, $(el).attr('value') ?? '')
  })
  body.set('user', creds.username)
  body.set('pass', creds.password)

  const postRes = await fetch(`${BASE_URL}${actionPath}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: nonceCookie,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!postRes.ok) throw new Error(`dga-ag.de login POST HTTP ${postRes.status}`)
  const sessionCookie = joinSetCookies(postRes)
  if (!sessionCookie.includes('fe_typo_user=')) {
    throw new Error('dga-ag.de login did not return a session cookie — check NUXT_DGA_AG_USERNAME/PASSWORD')
  }
  return sessionCookie
}

let cached: { cookie: string; at: number } | null = null
let inFlight: Promise<string> | null = null

/**
 * Cookie header for authenticated dga-ag.de requests, or null when no
 * credentials are configured (the crawler's existing public-only path).
 * Cached across calls within one process for SESSION_MAX_AGE_MS; pass
 * `forceRefresh` after detecting an expired session (a fetch redirected back
 * to /login.html) to get a new one instead of the stale cached cookie.
 */
export async function getDgaAgSessionCookie(opts: { forceRefresh?: boolean } = {}): Promise<string | null> {
  const creds = getCredentials()
  if (!creds) return null
  if (inFlight) return inFlight
  if (!opts.forceRefresh && cached && Date.now() - cached.at < SESSION_MAX_AGE_MS) {
    return cached.cookie
  }
  const promise = (async () => {
    const cookie = await login(creds)
    cached = { cookie, at: Date.now() }
    return cookie
  })()
  inFlight = promise
  try {
    return await promise
  } finally {
    inFlight = null
  }
}
