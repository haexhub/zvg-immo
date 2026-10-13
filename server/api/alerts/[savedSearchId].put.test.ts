import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/supabase', () => ({ getServiceClient: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

function makeEvent() {
  return { context: { params: { savedSearchId: 'search-9' }, user: { id: 'user-1' } } }
}

async function loadHandler(body: unknown, search: unknown = { id: 'search-9', filters: { country: 'de' } }) {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
  vi.stubGlobal('readBody', vi.fn(async () => body))

  const eq = vi.fn()
  const lookup = { eq, maybeSingle: vi.fn(async () => ({ data: search, error: null })) }
  eq.mockReturnValue(lookup)
  const upsert = vi.fn(async () => ({ error: null }))
  const from = vi.fn((table: string) => (table === 'saved_searches' ? { select: vi.fn(() => lookup) } : { upsert }))
  const { getServiceClient } = await import('../../utils/supabase')
  vi.mocked(getServiceClient).mockReturnValue({ from } as never)

  const handler = (await import('./[savedSearchId].put')).default as unknown as (event: unknown) => Promise<unknown>
  return { run: () => handler(makeEvent()), eq, upsert }
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
      { user_id: 'user-1', saved_search_id: 'search-9', enabled: false },
      { onConflict: 'saved_search_id' },
    )
  })

  it('looks the saved search up within the caller\'s own user_id scope before subscribing', async () => {
    const { run, eq, upsert } = await loadHandler({ enabled: true })
    await expect(run()).resolves.toEqual({ enabled: true })

    expect(eq).toHaveBeenCalledWith('id', 'search-9')
    expect(eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(upsert).toHaveBeenCalledWith({ user_id: 'user-1', saved_search_id: 'search-9', enabled: true }, { onConflict: 'saved_search_id' })
  })

  it('404s without subscribing when the saved search belongs to someone else', async () => {
    const { run, upsert } = await loadHandler({ enabled: true }, null)
    await expect(run()).rejects.toMatchObject({ statusCode: 404 })
    expect(upsert).not.toHaveBeenCalled()
  })
})
