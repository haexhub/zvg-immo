import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetch } from 'undici'
import { fetchAllListings } from './list'
import { MAP_PATH } from './constants'

// list.ts imports undici's fetch directly (for the custom TLS dispatcher), so
// stubbing the global fetch would let these tests reach the real host.
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
}))

function stubEventos(eventosBody: unknown): void {
  vi.mocked(fetch).mockImplementation(async (url) =>
    Response.json(String(url).includes(MAP_PATH) ? { list: [] } : eventosBody) as never,
  )
}

describe('fetchAllListings', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset()
  })

  it('accepts an empty but well-formed result set', async () => {
    stubEventos({ list: [], pagination: { total: 0 } })
    await expect(fetchAllListings('pt-eleiloes')).resolves.toEqual({ auctions: [], total: 0 })
  })

  it('throws instead of reporting page 1 as complete when pagination.total is missing', async () => {
    stubEventos({ list: [], pagination: {} })
    await expect(fetchAllListings('pt-eleiloes')).rejects.toThrow(/unexpected response shape/)
  })
})
