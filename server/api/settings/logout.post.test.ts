import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/db', () => ({ getPool: vi.fn(() => ({})) }))
vi.mock('../../utils/settings-auth', () => ({ rotateSessionEpoch: vi.fn(async () => undefined) }))

type Handler = (event: unknown) => Promise<unknown>

async function loadHandler(): Promise<Handler> {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
  vi.stubGlobal('deleteCookie', vi.fn())
  return (await import('./logout.post')).default as unknown as Handler
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/logout POST', () => {
  it('rotates the session epoch so every issued cookie is revoked, not only the caller\'s', async () => {
    const handler = await loadHandler()
    const { rotateSessionEpoch } = await import('../../utils/settings-auth')
    await expect(handler({})).resolves.toEqual({ ok: true })
    expect(rotateSessionEpoch).toHaveBeenCalledOnce()
    expect(deleteCookie).toHaveBeenCalledWith({}, 'settings_session', { path: '/' })
  })

  it('reports a failed rotation as 503 instead of a silent client-only logout', async () => {
    const handler = await loadHandler()
    const { rotateSessionEpoch } = await import('../../utils/settings-auth')
    vi.mocked(rotateSessionEpoch).mockRejectedValueOnce(new Error('db down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(handler({})).rejects.toMatchObject({ statusCode: 503 })
  })
})
