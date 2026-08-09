import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/supabase', () => ({ getServiceClient: vi.fn() }))

function insertChain(result: { data: unknown; error: unknown }): any {
  const promise = Promise.resolve(result)
  return Object.assign(promise, {
    insert: vi.fn(() => insertChain(result)),
    select: vi.fn(() => insertChain(result)),
    single: vi.fn(() => Promise.resolve(result)),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/watchlist POST', () => {
  it('does not expose a database failure to the authenticated client', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', async () => ({ platform: 'se-kronofogden', externalId: '101738' }))
    vi.stubGlobal('createError', (input: { statusCode: number, statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { getServiceClient } = await import('../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue({
      from: vi.fn(() => insertChain({ data: null, error: { message: 'duplicate details: internal-id-42' } })),
    } as never)

    const handler = (await import('./index.post')).default as unknown as (event: { context: { user: { id: string } } }) => Promise<unknown>
    const error = await handler({ context: { user: { id: 'user-1' } } }).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ statusCode: 500, statusMessage: 'Speichern fehlgeschlagen.' })
    expect(JSON.stringify(error)).not.toContain('internal-id-42')
  })
})
