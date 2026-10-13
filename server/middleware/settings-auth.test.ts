import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signSession } from '../utils/settings-auth'

const SECRET = 's'.repeat(64)
const setCookie = vi.fn()
let cookie: string | undefined

type Handler = (event: unknown) => unknown

function makeEvent(url: string) {
  return { node: { req: { url } } }
}

async function loadMiddleware(secret = SECRET): Promise<Handler> {
  vi.stubGlobal('useRuntimeConfig', () => ({ settingsSessionSecret: secret }))
  return (await import('./settings-auth')).default as unknown as Handler
}

beforeEach(() => {
  cookie = undefined
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
  vi.stubGlobal('getCookie', () => cookie)
  vi.stubGlobal('setCookie', setCookie)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('settings-auth middleware', () => {
  it('ignores routes outside /api/settings/', async () => {
    const handler = await loadMiddleware()
    expect(handler(makeEvent('/api/auctions?settings=1'))).toBeUndefined()
  })

  it.each(['/api/settings/login', '/api/settings/session?probe=1', '/api/Settings/Login'])(
    'lets the public path %s through without a session',
    async (url) => {
      const handler = await loadMiddleware()
      expect(handler(makeEvent(url))).toBeUndefined()
    },
  )

  it.each(['/api/settings/llm-config', '/api/Settings/llm-config', '/api/%73ettings/llm-config', '/api/settings/llm-config?x=/api/settings/login'])(
    'rejects %s with 401 when no session cookie is present',
    async (url) => {
      const handler = await loadMiddleware()
      expect(() => handler(makeEvent(url))).toThrow(expect.objectContaining({ statusCode: 401 }))
    },
  )

  it('rejects with 503 when no session secret is configured', async () => {
    const handler = await loadMiddleware('')
    expect(() => handler(makeEvent('/api/settings/llm-config'))).toThrow(expect.objectContaining({ statusCode: 503 }))
  })

  it('accepts a valid session and refreshes the cookie', async () => {
    cookie = signSession(SECRET, Date.now() + 60_000)
    const handler = await loadMiddleware()
    expect(handler(makeEvent('/api/settings/llm-config'))).toBeUndefined()
    expect(setCookie).toHaveBeenCalledWith(expect.anything(), 'settings_session', expect.any(String), expect.objectContaining({ httpOnly: true }))
  })
})
