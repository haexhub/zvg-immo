import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getUserFromEvent } from '../utils/supabase'

vi.mock('../utils/supabase', () => ({ getUserFromEvent: vi.fn() }))

type Handler = (event: unknown) => Promise<unknown>

function makeEvent(url: string) {
  return { node: { req: { url } }, context: {} as Record<string, unknown> }
}

async function loadMiddleware(): Promise<Handler> {
  return (await import('./supabase-auth')).default as unknown as Handler
}

beforeEach(() => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('supabase-auth middleware', () => {
  it('leaves unguarded routes untouched', async () => {
    const handler = await loadMiddleware()
    await expect(handler(makeEvent('/api/lawyers?country=de'))).resolves.toBeUndefined()
    expect(getUserFromEvent).not.toHaveBeenCalled()
  })

  it.each(['/api/saved-searches', '/api/Watchlist/123', '/api/%61pi-keys/abc', '/api/alerts/x?y=1'])(
    'rejects %s with 401 without a valid user',
    async (url) => {
      vi.mocked(getUserFromEvent).mockResolvedValue(null)
      const handler = await loadMiddleware()
      await expect(handler(makeEvent(url))).rejects.toMatchObject({ statusCode: 401 })
    },
  )

  it('sets event.context.user for an authenticated caller', async () => {
    const user = { id: 'user-1' }
    vi.mocked(getUserFromEvent).mockResolvedValue(user as never)
    const handler = await loadMiddleware()
    const event = makeEvent('/api/lawyer-inquiries')
    await handler(event)
    expect(event.context.user).toBe(user)
  })
})
