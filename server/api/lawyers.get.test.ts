import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils/supabase', () => ({ getServiceClient: vi.fn() }))

function chain(result: { data: unknown; error: unknown }): any {
  const promise = Promise.resolve(result)
  return Object.assign(promise, {
    select: vi.fn(() => chain(result)),
    eq: vi.fn(() => chain(result)),
    contains: vi.fn(() => chain(result)),
    order: vi.fn(() => chain(result)),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/lawyers GET', () => {
  it('does not expose a Supabase failure to public clients', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', () => ({ country: 'de' }))
    vi.stubGlobal('createError', (input: { statusCode: number, statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { getServiceClient } = await import('../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue({
      from: vi.fn(() => chain({ data: null, error: { message: 'database connection password=secret' } })),
    } as never)

    const handler = (await import('./lawyers.get')).default as unknown as () => Promise<unknown>
    const error = await handler().catch((cause: unknown) => cause)

    expect(error).toMatchObject({ statusCode: 500, statusMessage: 'Anwälte konnten nicht geladen werden.' })
    expect(JSON.stringify(error)).not.toContain('database connection password=secret')
  })
})
