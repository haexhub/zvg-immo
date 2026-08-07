import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/supabase', () => ({ getServiceClient: vi.fn() }))

function chain(result: { data: unknown; error: unknown }, orderSpy?: (...args: unknown[]) => void): any {
  const promise = Promise.resolve(result)
  return Object.assign(promise, {
    select: vi.fn(() => chain(result, orderSpy)),
    order: vi.fn((...args: unknown[]) => {
      orderSpy?.(...args)
      return chain(result, orderSpy)
    }),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/lawyers GET', () => {
  it('rejects with 503 when Supabase is not configured', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { getServiceClient } = await import('../../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue(null as never)

    const handler = (await import('./index.get')).default as unknown as () => Promise<unknown>
    await expect(handler()).rejects.toMatchObject({ statusCode: 503 })
  })

  it('maps rows to the admin lawyer shape, ordered by name', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const orderSpy = vi.fn()
    const from = vi.fn(() => chain({
      data: [{
        id: '1',
        name: 'Jane Doe',
        firm: null,
        email: 'jane@example.com',
        phone: null,
        countries: ['de'],
        specialization: null,
        languages: null,
        website: null,
        commission_cents: 5000,
        active: true,
        created_at: '2026-01-01T00:00:00.000Z',
      }],
      error: null,
    }, orderSpy))
    const { getServiceClient } = await import('../../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue({ from } as never)

    const handler = (await import('./index.get')).default as unknown as () => Promise<unknown>
    await expect(handler()).resolves.toEqual([{
      id: '1',
      name: 'Jane Doe',
      firm: null,
      email: 'jane@example.com',
      phone: null,
      countries: ['de'],
      specialization: null,
      languages: null,
      website: null,
      commissionCents: 5000,
      active: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    }])
    expect(from).toHaveBeenCalledWith('lawyers')
    expect(orderSpy).toHaveBeenCalledWith('name', { ascending: true })
  })

  it('rejects with 500 on a database error', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const from = vi.fn(() => chain({ data: null, error: { message: 'connection lost' } }))
    const { getServiceClient } = await import('../../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue({ from } as never)

    const handler = (await import('./index.get')).default as unknown as () => Promise<unknown>
    await expect(handler()).rejects.toMatchObject({ statusCode: 500, message: 'connection lost' })
  })
})
