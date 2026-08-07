import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/settings-auth', () => ({
  checkRateLimit: vi.fn(() => true),
  recordFailedAttempt: vi.fn(),
  signSession: vi.fn(() => 'signed-session-token'),
  timingSafePasswordEqual: vi.fn(() => false),
}))

function makeEvent(remoteAddress = '10.0.0.1') {
  return {
    node: { req: { socket: { remoteAddress } } },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/login POST', () => {
  it('rejects with 503 when settings password/secret are not configured', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('useRuntimeConfig', () => ({ settingsPassword: '', settingsSessionSecret: '' }))

    const handler = (await import('./login.post')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent())).rejects.toMatchObject({ statusCode: 503 })
  })

  it('rejects with 429 without checking the password when the IP is rate-limited', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('useRuntimeConfig', () => ({ settingsPassword: 'correct', settingsSessionSecret: 'secret' }))
    vi.stubGlobal('getRequestHeader', () => undefined)
    vi.stubGlobal('readBody', vi.fn(async () => ({ password: 'correct' })))

    const { checkRateLimit, timingSafePasswordEqual } = await import('../../utils/settings-auth')
    vi.mocked(checkRateLimit).mockReturnValue(false)

    const handler = (await import('./login.post')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent())).rejects.toMatchObject({ statusCode: 429 })
    expect(timingSafePasswordEqual).not.toHaveBeenCalled()
  })

  it('rejects with 401 and records the failed attempt on a wrong password', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('useRuntimeConfig', () => ({ settingsPassword: 'correct', settingsSessionSecret: 'secret' }))
    vi.stubGlobal('getRequestHeader', () => undefined)
    vi.stubGlobal('readBody', vi.fn(async () => ({ password: 'wrong' })))
    vi.stubGlobal('setCookie', vi.fn())

    const { checkRateLimit, timingSafePasswordEqual, recordFailedAttempt } = await import('../../utils/settings-auth')
    vi.mocked(checkRateLimit).mockReturnValue(true)
    vi.mocked(timingSafePasswordEqual).mockReturnValue(false)

    const handler = (await import('./login.post')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent('203.0.113.9'))).rejects.toMatchObject({ statusCode: 401 })
    expect(recordFailedAttempt).toHaveBeenCalledWith('203.0.113.9', expect.any(Number))
  })

  it('signs a session cookie and returns ok on a correct password', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('useRuntimeConfig', () => ({ settingsPassword: 'correct', settingsSessionSecret: 'secret' }))
    vi.stubGlobal('getRequestHeader', () => undefined)
    vi.stubGlobal('readBody', vi.fn(async () => ({ password: 'correct' })))
    const setCookie = vi.fn()
    vi.stubGlobal('setCookie', setCookie)

    const { checkRateLimit, timingSafePasswordEqual, signSession } = await import('../../utils/settings-auth')
    vi.mocked(checkRateLimit).mockReturnValue(true)
    vi.mocked(timingSafePasswordEqual).mockReturnValue(true)

    const handler = (await import('./login.post')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent())).resolves.toEqual({ ok: true })
    expect(signSession).toHaveBeenCalledWith('secret', expect.any(Number))
    expect(setCookie).toHaveBeenCalledWith(
      expect.anything(),
      'settings_session',
      'signed-session-token',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    )
  })

  it('keys the rate limit off the socket address when x-forwarded-for is not trusted', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('useRuntimeConfig', () => ({ settingsPassword: 'correct', settingsSessionSecret: 'secret', trustForwardedFor: '' }))
    vi.stubGlobal('getRequestHeader', () => '198.51.100.1, 203.0.113.5')
    vi.stubGlobal('readBody', vi.fn(async () => ({ password: 'wrong' })))

    const { checkRateLimit, timingSafePasswordEqual } = await import('../../utils/settings-auth')
    vi.mocked(checkRateLimit).mockReturnValue(true)
    vi.mocked(timingSafePasswordEqual).mockReturnValue(false)

    const handler = (await import('./login.post')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent('10.0.0.1'))).rejects.toMatchObject({ statusCode: 401 })
    expect(checkRateLimit).toHaveBeenCalledWith('10.0.0.1', expect.any(Number))
  })

  it('keys the rate limit off the last x-forwarded-for entry when trusted', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('useRuntimeConfig', () => ({ settingsPassword: 'correct', settingsSessionSecret: 'secret', trustForwardedFor: '1' }))
    vi.stubGlobal('getRequestHeader', () => '198.51.100.1, 203.0.113.5')
    vi.stubGlobal('readBody', vi.fn(async () => ({ password: 'wrong' })))

    const { checkRateLimit, timingSafePasswordEqual } = await import('../../utils/settings-auth')
    vi.mocked(checkRateLimit).mockReturnValue(true)
    vi.mocked(timingSafePasswordEqual).mockReturnValue(false)

    const handler = (await import('./login.post')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent('10.0.0.1'))).rejects.toMatchObject({ statusCode: 401 })
    expect(checkRateLimit).toHaveBeenCalledWith('203.0.113.5', expect.any(Number))
  })
})
