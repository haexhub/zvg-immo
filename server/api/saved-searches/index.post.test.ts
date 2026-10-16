import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/supabase', () => ({ getServiceClient: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

async function loadHandler(body: unknown) {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('readBody', async () => body)
  vi.stubGlobal('createError', (input: { statusCode: number, statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
  const insert = vi.fn((row: { name: string, filters: unknown }) => ({
    select: () => ({ single: async () => ({ data: { id: 's-1', created_at: 'now', ...row }, error: null }) }),
  }))
  const { getServiceClient } = await import('../../utils/supabase')
  vi.mocked(getServiceClient).mockReturnValue({ from: vi.fn(() => ({ insert })) } as never)
  const handler = (await import('./index.post')).default as unknown as (event: unknown) => Promise<unknown>
  return { run: () => handler({ context: { user: { id: 'user-1' } } }), insert }
}

describe('/api/saved-searches POST', () => {
  it('stores the contract serialization instead of the raw filter object', async () => {
    const { run, insert } = await loadHandler({
      name: 'Sachsen',
      filters: { country: 'DE', priceMax: '200000', priceMin: { nested: true }, junk: ['x'] },
    })

    await run()

    expect(insert).toHaveBeenCalledWith({
      user_id: 'user-1', name: 'Sachsen', filters: { country: 'de', priceMax: '200000' },
    })
  })

  it('keeps an explicit llmOnly=0 override of the admin hideRulesOnly default', async () => {
    const { run, insert } = await loadHandler({ name: 'Alle', filters: { country: 'de', llmOnly: '0' } })

    await run()

    expect(insert).toHaveBeenCalledWith({
      user_id: 'user-1', name: 'Alle', filters: { country: 'de', llmOnly: '0' },
    })
  })

  it.each([
    { name: 'x'.repeat(201), filters: {} },
    { name: 'Suche', filters: { q: 'x'.repeat(5_000) } },
  ])('rejects oversized input before writing', async (body) => {
    const { run, insert } = await loadHandler(body)
    await expect(run()).rejects.toMatchObject({ statusCode: 400 })
    expect(insert).not.toHaveBeenCalled()
  })
})
