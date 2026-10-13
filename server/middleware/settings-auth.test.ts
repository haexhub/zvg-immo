import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSessionEpochCache, SESSION_MAX_AGE_MS, sessionSigningKey, signSession } from '../utils/settings-auth'

const readSetting = vi.fn()
vi.mock('../utils/db', () => ({ getPool: vi.fn(() => ({})) }))
vi.mock('../utils/app-settings-store', () => ({ readSetting: (...args: unknown[]) => readSetting(...args), writeSetting: vi.fn() }))

const SECRET = 's'.repeat(64)
const PASSWORD = 'admin-password'
const EPOCH = 'epoch-1'
const KEY = sessionSigningKey(SECRET, PASSWORD, EPOCH)
const setCookie = vi.fn()
let cookie: string | undefined

type Handler = (event: unknown) => unknown

function makeEvent(url: string) {
  return { node: { req: { url } } }
}

async function loadMiddleware(secret = SECRET): Promise<Handler> {
  vi.stubGlobal('useRuntimeConfig', () => ({ settingsSessionSecret: secret, settingsPassword: PASSWORD }))
  return (await import('./settings-auth')).default as unknown as Handler
}

beforeEach(() => {
  cookie = undefined
  resetSessionEpochCache()
  readSetting.mockResolvedValue({ value: EPOCH })
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
    await expect(handler(makeEvent('/api/auctions?settings=1'))).resolves.toBeUndefined()
  })

  it.each(['/api/settings/login', '/api/settings/session?probe=1', '/api/Settings/Login'])(
    'lets the public path %s through without a session',
    async (url) => {
      const handler = await loadMiddleware()
      await expect(handler(makeEvent(url))).resolves.toBeUndefined()
    },
  )

  it.each(['/api/settings/llm-config', '/api/Settings/llm-config', '/api/%73ettings/llm-config', '/api/settings/llm-config?x=/api/settings/login'])(
    'rejects %s with 401 when no session cookie is present',
    async (url) => {
      const handler = await loadMiddleware()
      await expect(handler(makeEvent(url))).rejects.toMatchObject({ statusCode: 401 })
    },
  )

  it('rejects with 503 when no session secret is configured', async () => {
    const handler = await loadMiddleware('')
    await expect(handler(makeEvent('/api/settings/llm-config'))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('accepts a valid session and refreshes the cookie keeping the issue time', async () => {
    const issuedAt = Date.now() - 1000
    cookie = signSession(KEY, issuedAt, Date.now() + 60_000)
    const handler = await loadMiddleware()
    await expect(handler(makeEvent('/api/settings/llm-config'))).resolves.toBeUndefined()
    expect(setCookie).toHaveBeenCalledWith(expect.anything(), 'settings_session', expect.stringMatching(new RegExp(`^${issuedAt}\\.`)), expect.objectContaining({ httpOnly: true }))
  })

  it('rejects a session past its absolute max age despite a fresh expiry', async () => {
    cookie = signSession(KEY, Date.now() - SESSION_MAX_AGE_MS, Date.now() + 60_000)
    const handler = await loadMiddleware()
    await expect(handler(makeEvent('/api/settings/llm-config'))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects a session signed before the admin password changed', async () => {
    cookie = signSession(sessionSigningKey(SECRET, 'old-password', EPOCH), Date.now(), Date.now() + 60_000)
    const handler = await loadMiddleware()
    await expect(handler(makeEvent('/api/settings/llm-config'))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects a session signed before a logout rotated the epoch', async () => {
    cookie = signSession(KEY, Date.now(), Date.now() + 60_000)
    readSetting.mockResolvedValue({ value: 'epoch-2' })
    const handler = await loadMiddleware()
    await expect(handler(makeEvent('/api/settings/llm-config'))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('fails closed with 503 when the session epoch cannot be read', async () => {
    cookie = signSession(KEY, Date.now(), Date.now() + 60_000)
    readSetting.mockRejectedValue(new Error('db down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handler = await loadMiddleware()
    await expect(handler(makeEvent('/api/settings/llm-config'))).rejects.toMatchObject({ statusCode: 503 })
  })
})
