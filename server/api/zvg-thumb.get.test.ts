import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(() => Promise.reject(new Error('ENOENT'))),
  rename: vi.fn(),
  writeFile: vi.fn(),
}))
vi.mock('../utils/extract/pdf-text', () => ({ fetchPdfBuffer: vi.fn() }))
vi.mock('../utils/extract/pdf-render', () => ({ renderPdfPageJpeg: vi.fn() }))

type Handler = (event: { query: Record<string, string> }) => Promise<Buffer>

async function loadHandler(): Promise<Handler> {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getQuery', (event: { query: Record<string, string> }) => event.query)
  vi.stubGlobal('setHeader', vi.fn())
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) =>
    Object.assign(new Error(input.statusMessage), input))
  return (await import('./zvg-thumb.get')).default as unknown as Handler
}

function thumbEvent(zvgId: string) {
  return { query: { file_id: '1', zvg_id: zvgId, land_abk: 'sn' } }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/zvg-thumb', () => {
  it('refuses uncached renders beyond the concurrency cap instead of spawning more upstream fetches', async () => {
    const { fetchPdfBuffer } = await import('../utils/extract/pdf-text')
    const { renderPdfPageJpeg } = await import('../utils/extract/pdf-render')
    const releases: Array<(buf: Buffer) => void> = []
    vi.mocked(fetchPdfBuffer).mockImplementation(() => new Promise((resolve) => { releases.push(resolve) }))
    vi.mocked(renderPdfPageJpeg).mockResolvedValue(Buffer.from('jpeg'))
    const handler = await loadHandler()

    const inFlight = [handler(thumbEvent('1')), handler(thumbEvent('2'))]
    await vi.waitFor(() => expect(fetchPdfBuffer).toHaveBeenCalledTimes(2))
    await expect(handler(thumbEvent('3'))).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchPdfBuffer).toHaveBeenCalledTimes(2)

    for (const release of releases) release(Buffer.from('%PDF-'))
    await expect(Promise.all(inFlight)).resolves.toEqual([Buffer.from('jpeg'), Buffer.from('jpeg')])
    vi.mocked(fetchPdfBuffer).mockResolvedValue(Buffer.from('%PDF-'))
    await expect(handler(thumbEvent('3'))).resolves.toEqual(Buffer.from('jpeg'))
  })

  it('hides upstream failure details from the anonymous client', async () => {
    const { fetchPdfBuffer } = await import('../utils/extract/pdf-text')
    const { renderPdfPageJpeg } = await import('../utils/extract/pdf-render')
    vi.mocked(fetchPdfBuffer).mockResolvedValue(Buffer.from('%PDF-'))
    vi.mocked(renderPdfPageJpeg).mockRejectedValue(new Error('pdftoppm failed for /tmp/pdf-render-x.pdf'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const handler = await loadHandler()

    const err = await handler(thumbEvent('4')).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 502 })
    expect(JSON.stringify(err)).not.toContain('/tmp/')
  })
})
