import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/supabase', () => ({ getServiceClient: vi.fn() }))

function chain(result: { data: unknown; error: unknown }): any {
  const promise = Promise.resolve(result)
  return Object.assign(promise, {
    insert: vi.fn(() => chain(result)),
    select: vi.fn(() => chain(result)),
    single: vi.fn(() => chain(result)),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/lawyers POST', () => {
  it('rejects with 400 when required fields are missing', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('readBody', vi.fn(async () => ({ name: 'Jane' })))

    const handler = (await import('./index.post')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects with 503 when Supabase is not configured', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('readBody', vi.fn(async () => ({ name: 'Jane', email: 'jane@example.com', countries: ['de'] })))
    const { getServiceClient } = await import('../../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue(null as never)

    const handler = (await import('./index.post')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({})).rejects.toMatchObject({ statusCode: 503 })
  })

  it('inserts the parsed lawyer and returns the mapped row', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('readBody', vi.fn(async () => ({ name: 'Jane Doe', email: 'jane@example.com', countries: ['de'] })))
    const insert = vi.fn(() => chain({
      data: {
        id: '1', name: 'Jane Doe', firm: null, email: 'jane@example.com', phone: null,
        countries: ['de'], specialization: null, languages: null, website: null,
        commission_cents: null, active: true, created_at: '2026-01-01T00:00:00.000Z',
      },
      error: null,
    }))
    const from = vi.fn(() => ({ insert }))
    const { getServiceClient } = await import('../../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue({ from } as never)

    const handler = (await import('./index.post')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({})).resolves.toMatchObject({ id: '1', name: 'Jane Doe', active: true })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jane Doe', email: 'jane@example.com', countries: ['de'] }))
  })

  it('rejects with 500 when the insert fails', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('readBody', vi.fn(async () => ({ name: 'Jane Doe', email: 'jane@example.com', countries: ['de'] })))
    const insert = vi.fn(() => chain({ data: null, error: { message: 'duplicate key' } }))
    const from = vi.fn(() => ({ insert }))
    const { getServiceClient } = await import('../../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue({ from } as never)

    const handler = (await import('./index.post')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler({})).rejects.toMatchObject({ statusCode: 500, message: 'duplicate key' })
  })
})
