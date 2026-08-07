import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/supabase', () => ({ getServiceClient: vi.fn() }))

function chain(result: { data: unknown; error: unknown }): any {
  const promise = Promise.resolve(result)
  return Object.assign(promise, {
    update: vi.fn(() => chain(result)),
    eq: vi.fn(() => chain(result)),
    select: vi.fn(() => chain(result)),
    single: vi.fn(() => chain(result)),
  })
}

function makeEvent(id: string | undefined) {
  return { context: { params: { id } } }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/lawyers/[id] PUT', () => {
  it('rejects with 400 when id is missing', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./[id].put')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent(undefined))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects with 400 when the body fails validation', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('readBody', vi.fn(async () => ({})))

    const handler = (await import('./[id].put')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent('1'))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('updates the row and returns the mapped result', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('readBody', vi.fn(async () => ({ name: 'Jane Doe', email: 'jane@example.com', countries: ['de'], active: false })))
    const update = vi.fn(() => chain({
      data: {
        id: '1', name: 'Jane Doe', firm: null, email: 'jane@example.com', phone: null,
        countries: ['de'], specialization: null, languages: null, website: null,
        commission_cents: null, active: false, created_at: '2026-01-01T00:00:00.000Z',
      },
      error: null,
    }))
    const from = vi.fn(() => ({ update }))
    const { getServiceClient } = await import('../../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue({ from } as never)

    const handler = (await import('./[id].put')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent('1'))).resolves.toMatchObject({ id: '1', active: false })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ active: false }))
  })

  it('rejects with 404 when no row matches the id', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.stubGlobal('readBody', vi.fn(async () => ({ name: 'Jane Doe', email: 'jane@example.com', countries: ['de'] })))
    const update = vi.fn(() => chain({ data: null, error: null }))
    const from = vi.fn(() => ({ update }))
    const { getServiceClient } = await import('../../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue({ from } as never)

    const handler = (await import('./[id].put')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent('missing'))).rejects.toMatchObject({ statusCode: 404 })
  })
})
