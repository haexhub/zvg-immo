import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

function stubHandlerGlobals() {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) =>
    Object.assign(new Error(input.statusMessage), input),
  )
  vi.stubGlobal('sendRedirect', vi.fn((_event: unknown, url: string, code: number) => ({ url, code })))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('GET /api/bg-zapori-document/:externalId/:fileId', () => {
  it('rejects an unsafe externalId/fileId', async () => {
    stubHandlerGlobals()
    const handler = (await import('./[fileId].get')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(
      handler({ context: { params: { externalId: '../etc', fileId: '1215' } } }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('redirects to the freshly-fetched signed href', async () => {
    stubHandlerGlobals()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          attachments: [{ id: 1215, blob: { href: 'https://zapori.mjs.bg/api/blobs/1215?t=999&h=fresh' } }],
        }),
      ),
    )
    const handler = (await import('./[fileId].get')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(
      handler({ context: { params: { externalId: '1274', fileId: '1215' } } }),
    ).resolves.toEqual({ url: 'https://zapori.mjs.bg/api/blobs/1215?t=999&h=fresh', code: 302 })
  })

  it('404s when the attachment id is no longer in the announcement', async () => {
    stubHandlerGlobals()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ attachments: [] })))
    const handler = (await import('./[fileId].get')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(
      handler({ context: { params: { externalId: '1274', fileId: '1215' } } }),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('502s when the upstream announcement fetch fails', async () => {
    stubHandlerGlobals()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    const handler = (await import('./[fileId].get')).default as unknown as (event: unknown) => Promise<unknown>
    await expect(
      handler({ context: { params: { externalId: '1274', fileId: '1215' } } }),
    ).rejects.toMatchObject({ statusCode: 502 })
  })
})
