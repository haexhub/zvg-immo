import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname === 'internal.test') return [{ address: '10.0.0.5', family: 4 }]
    if (hostname === 'mixed.test') return [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]
    return [{ address: '93.184.216.34', family: 4 }]
  }),
}))

const { fetchPublicUrl, isPublicHost } = await import('./public-fetch')

const init = () => ({ headers: { 'User-Agent': 'test', Cookie: 'session=1' }, signal: AbortSignal.timeout(1_000) })

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

describe('isPublicHost', () => {
  it('rejects loopback, link-local and private literals and any private DNS answer', async () => {
    expect(await isPublicHost('127.0.0.1')).toBe(false)
    expect(await isPublicHost('169.254.169.254')).toBe(false)
    expect(await isPublicHost('[::1]')).toBe(false)
    expect(await isPublicHost('internal.test')).toBe(false)
    expect(await isPublicHost('mixed.test')).toBe(false)
    expect(await isPublicHost('portal.test')).toBe(true)
  })
})

describe('fetchPublicUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refuses a private start URL without fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchPublicUrl('http://169.254.169.254/latest/meta-data/', init())).rejects.toThrow(/non-public host/)
    await expect(fetchPublicUrl('file:///etc/passwd', init())).rejects.toThrow(/non-http/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('re-checks each redirect hop and stops at an internal target', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect('http://internal.test/admin'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchPublicUrl('https://portal.test/doc.pdf', init())).rejects.toThrow(/internal\.test/)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' })
  })

  it('follows public redirects and drops credentials on a cross-origin hop', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect('/moved.pdf'))
      .mockResolvedValueOnce(redirect('https://cdn.test/final.pdf'))
      .mockResolvedValueOnce(new Response('%PDF-1.4', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchPublicUrl('https://portal.test/doc.pdf', init())
    expect(await res.text()).toBe('%PDF-1.4')
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://portal.test/doc.pdf',
      'https://portal.test/moved.pdf',
      'https://cdn.test/final.pdf',
    ])
    expect(fetchMock.mock.calls[1]![1].headers).toHaveProperty('Cookie')
    expect(fetchMock.mock.calls[2]![1].headers).not.toHaveProperty('Cookie')
  })
})
