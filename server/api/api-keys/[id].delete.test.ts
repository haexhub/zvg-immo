import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/supabase', () => ({ getServiceClient: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/api-keys/[id] DELETE', () => {
  it('revokes the key only within the caller\'s own user_id scope', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const eq = vi.fn()
    const chain = Object.assign(Promise.resolve({ error: null }), { eq })
    eq.mockReturnValue(chain)
    const update = vi.fn(() => chain)
    const { getServiceClient } = await import('../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue({ from: vi.fn(() => ({ update })) } as never)

    const handler = (await import('./[id].delete')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({ context: { params: { id: 'key-9' }, user: { id: 'user-1' } } })).resolves.toEqual({ ok: true })

    expect(update).toHaveBeenCalledWith({ active: false })
    expect(eq).toHaveBeenCalledWith('id', 'key-9')
    expect(eq).toHaveBeenCalledWith('user_id', 'user-1')
  })
})
