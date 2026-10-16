import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/supabase', () => ({ getServiceClient: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/saved-searches GET', () => {
  it('lists only the caller\'s own saved searches', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const order = vi.fn(async () => ({ data: [{ id: 's1', name: 'Berlin', filters: {}, created_at: '2026-10-01' }], error: null }))
    const eq = vi.fn(() => ({ order }))
    const { getServiceClient } = await import('../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue({ from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })) } as never)

    const handler = (await import('./index.get')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({ context: { user: { id: 'user-1' } } })).resolves.toEqual([
      { id: 's1', name: 'Berlin', filters: {}, createdAt: '2026-10-01' },
    ])
    expect(eq).toHaveBeenCalledWith('user_id', 'user-1')
  })
})
