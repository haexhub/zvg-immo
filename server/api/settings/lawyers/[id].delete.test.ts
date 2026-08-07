import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/supabase', () => ({ getServiceClient: vi.fn() }))

function chain(result: { error: unknown }, eqSpy?: (...args: unknown[]) => void): any {
  const promise = Promise.resolve(result)
  return Object.assign(promise, {
    delete: vi.fn(() => chain(result, eqSpy)),
    eq: vi.fn((...args: unknown[]) => {
      eqSpy?.(...args)
      return chain(result, eqSpy)
    }),
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

describe('/api/settings/lawyers/[id] DELETE', () => {
  it('rejects with 400 when id is missing', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./[id].delete')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent(undefined))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects with 503 when Supabase is not configured', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { getServiceClient } = await import('../../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue(null as never)

    const handler = (await import('./[id].delete')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent('1'))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('deletes and returns ok', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const eqSpy = vi.fn()
    const del = vi.fn(() => chain({ error: null }, eqSpy))
    const from = vi.fn(() => ({ delete: del }))
    const { getServiceClient } = await import('../../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue({ from } as never)

    const handler = (await import('./[id].delete')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent('1'))).resolves.toEqual({ ok: true })
    expect(from).toHaveBeenCalledWith('lawyers')
    expect(del).toHaveBeenCalled()
    expect(eqSpy).toHaveBeenCalledWith('id', '1')
  })

  it('maps a foreign-key violation (still-referenced lawyer) to a 409 with a deactivate-instead message', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const del = vi.fn(() => chain({ error: { code: '23503', message: 'FK violation' } }))
    const from = vi.fn(() => ({ delete: del }))
    const { getServiceClient } = await import('../../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue({ from } as never)

    const handler = (await import('./[id].delete')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent('1'))).rejects.toMatchObject({
      statusCode: 409,
      statusMessage: expect.stringContaining('deaktivieren'),
    })
  })

  it('maps any other database error to a 500', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const del = vi.fn(() => chain({ error: { code: '42601', message: 'syntax error' } }))
    const from = vi.fn(() => ({ delete: del }))
    const { getServiceClient } = await import('../../../utils/supabase')
    vi.mocked(getServiceClient).mockReturnValue({ from } as never)

    const handler = (await import('./[id].delete')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(handler(makeEvent('1'))).rejects.toMatchObject({ statusCode: 500, message: 'syntax error' })
  })
})
