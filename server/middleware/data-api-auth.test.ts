import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getApiKeyRecord } from '../utils/api-key'

vi.mock('../utils/api-key', () => ({ getApiKeyRecord: vi.fn() }))
vi.mock('../utils/supabase', () => ({ getServiceClient: vi.fn(() => null) }))

type Handler = (event: unknown) => Promise<unknown>

function makeEvent(url: string) {
  return { node: { req: { url } }, context: {} as Record<string, unknown> }
}

async function loadMiddleware(): Promise<Handler> {
  return (await import('./data-api-auth')).default as unknown as Handler
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

describe('data-api-auth middleware', () => {
  it('leaves routes outside /api/data/ untouched', async () => {
    const handler = await loadMiddleware()
    await expect(handler(makeEvent('/api/auctions'))).resolves.toBeUndefined()
    expect(getApiKeyRecord).not.toHaveBeenCalled()
  })

  it('rejects with 401 without a valid API key', async () => {
    vi.mocked(getApiKeyRecord).mockResolvedValue(null)
    const handler = await loadMiddleware()
    await expect(handler(makeEvent('/api/data/v1/auctions'))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('sets the key context and answers 429 once the burst limit of 60 is exhausted', async () => {
    vi.mocked(getApiKeyRecord).mockResolvedValue({ id: 'key-1', user_id: 'user-1' } as never)
    const handler = await loadMiddleware()
    const event = makeEvent('/api/data/v1/auctions')
    for (let i = 0; i < 60; i++) await handler(event)
    expect(event.context.apiKey).toEqual({ id: 'key-1', userId: 'user-1' })
    await expect(handler(makeEvent('/api/data/v1/auctions'))).rejects.toMatchObject({ statusCode: 429 })
  })

  it('shares one burst budget across all keys of the same user', async () => {
    const handler = await loadMiddleware()

    for (let i = 0; i < 60; i++) {
      vi.mocked(getApiKeyRecord).mockResolvedValueOnce({ id: `key-${i}`, user_id: 'user-a' } as never)
      await handler(makeEvent('/api/data/v1/auctions'))
    }
    vi.mocked(getApiKeyRecord).mockResolvedValueOnce({ id: 'key-fresh', user_id: 'user-a' } as never)
    await expect(handler(makeEvent('/api/data/v1/auctions'))).rejects.toMatchObject({ statusCode: 429 })

    vi.mocked(getApiKeyRecord).mockResolvedValueOnce({ id: 'key-other', user_id: 'user-b' } as never)
    await expect(handler(makeEvent('/api/data/v1/auctions'))).resolves.toBeUndefined()
  })
})
