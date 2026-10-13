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
  const upsert = vi.fn(async () => ({ error: null }))
  const searchQuery = {
    select: () => searchQuery,
    eq: () => searchQuery,
    maybeSingle: async () => ({ data: { id: 'search-1', filters: { country: 'de' } }, error: null }),
  }
  const { getServiceClient } = await import('../../utils/supabase')
  vi.mocked(getServiceClient).mockReturnValue({
    from: vi.fn((table: string) => (table === 'saved_searches' ? searchQuery : { upsert })),
  } as never)
  const handler = (await import('./[savedSearchId].put')).default as unknown as (event: unknown) => Promise<unknown>
  const event = { context: { params: { savedSearchId: 'search-1' }, user: { id: 'user-1' } } }
  return { run: () => handler(event), upsert }
}

describe('/api/alerts/[savedSearchId] PUT', () => {
  it.each([undefined, {}, { enabled: 'false' }, { enabled: 0 }, { enabled: null }])(
    'rejects a non-boolean enabled flag (%j) instead of enabling the alert',
    async (body) => {
      const { run, upsert } = await loadHandler(body)
      await expect(run()).rejects.toMatchObject({ statusCode: 400 })
      expect(upsert).not.toHaveBeenCalled()
    },
  )

  it('persists an explicit disable', async () => {
    const { run, upsert } = await loadHandler({ enabled: false })
    await expect(run()).resolves.toEqual({ enabled: false })
    expect(upsert).toHaveBeenCalledWith(
      { user_id: 'user-1', saved_search_id: 'search-1', enabled: false },
      { onConflict: 'saved_search_id' },
    )
  })
})
