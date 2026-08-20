import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { getDgaAgSessionCookie as GetDgaAgSessionCookie } from './session'

const LOGIN_HTML = `
<html><body>
<form action="/login.html?tx_felogin_login%5Baction%5D=login&tx_felogin_login%5Bcontroller%5D=Login&cHash=abc123" method="post">
<input type="hidden" name="__RequestToken" value="token-xyz" >
<input type="hidden" name="pid" value="721" >
<input type="submit" value="" name="submit" />
</form>
</body></html>
`

function withSetCookie(body: string, cookies: string[]): Response {
  const headers = new Headers()
  for (const c of cookies) headers.append('set-cookie', c)
  return new Response(body, { status: 200, headers })
}

let getDgaAgSessionCookie: typeof GetDgaAgSessionCookie

beforeEach(async () => {
  vi.resetModules()
  ;({ getDgaAgSessionCookie } = await import('./session'))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getDgaAgSessionCookie', () => {
  it('returns null and never fetches when no credentials are configured', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ dgaAg: { username: '', password: '' } }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(await getDgaAgSessionCookie()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('logs in via the felogin GET/POST flow and returns the session cookie', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ dgaAg: { username: 'user@test.de', password: 'secret' } }))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(withSetCookie(LOGIN_HTML, ['__Secure-typo3nonce_x=nonce123; path=/; secure']))
      .mockResolvedValueOnce(withSetCookie('<html>Herzlich Willkommen</html>', ['fe_typo_user=session456; path=/']))
    vi.stubGlobal('fetch', fetchMock)

    const cookie = await getDgaAgSessionCookie()
    expect(cookie).toBe('fe_typo_user=session456')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const [postUrl, postInit] = fetchMock.mock.calls[1]!
    expect(postUrl).toBe(
      'https://www.dga-ag.de/login.html?tx_felogin_login%5Baction%5D=login&tx_felogin_login%5Bcontroller%5D=Login&cHash=abc123',
    )
    expect(postInit.headers.Cookie).toBe('__Secure-typo3nonce_x=nonce123')
    const body = new URLSearchParams(postInit.body)
    expect(body.get('user')).toBe('user@test.de')
    expect(body.get('pass')).toBe('secret')
    expect(body.get('__RequestToken')).toBe('token-xyz')
    expect(body.get('pid')).toBe('721')
  })

  it('reuses the cached session across repeated calls instead of logging in again', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ dgaAg: { username: 'user@test.de', password: 'secret' } }))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(withSetCookie(LOGIN_HTML, ['__Secure-typo3nonce_x=nonce123; path=/']))
      .mockResolvedValueOnce(withSetCookie('ok', ['fe_typo_user=session456; path=/']))
    vi.stubGlobal('fetch', fetchMock)

    const first = await getDgaAgSessionCookie()
    const second = await getDgaAgSessionCookie()
    expect(first).toBe(second)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('forceRefresh logs in again even though the cached session is still fresh', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ dgaAg: { username: 'user@test.de', password: 'secret' } }))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(withSetCookie(LOGIN_HTML, ['__Secure-typo3nonce_x=nonce1; path=/']))
      .mockResolvedValueOnce(withSetCookie('ok', ['fe_typo_user=session1; path=/']))
      .mockResolvedValueOnce(withSetCookie(LOGIN_HTML, ['__Secure-typo3nonce_x=nonce2; path=/']))
      .mockResolvedValueOnce(withSetCookie('ok', ['fe_typo_user=session2; path=/']))
    vi.stubGlobal('fetch', fetchMock)

    const first = await getDgaAgSessionCookie()
    const second = await getDgaAgSessionCookie({ forceRefresh: true })
    expect(first).toBe('fe_typo_user=session1')
    expect(second).toBe('fe_typo_user=session2')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('coalesces concurrent forceRefresh calls into a single login', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ dgaAg: { username: 'user@test.de', password: 'secret' } }))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(withSetCookie(LOGIN_HTML, ['__Secure-typo3nonce_x=nonce1; path=/']))
      .mockResolvedValueOnce(withSetCookie('ok', ['fe_typo_user=session1; path=/']))
    vi.stubGlobal('fetch', fetchMock)

    const [first, second] = await Promise.all([
      getDgaAgSessionCookie({ forceRefresh: true }),
      getDgaAgSessionCookie({ forceRefresh: true }),
    ])
    expect(first).toBe('fe_typo_user=session1')
    expect(second).toBe('fe_typo_user=session1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws when the login response carries no fe_typo_user cookie (wrong credentials)', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ dgaAg: { username: 'user@test.de', password: 'wrong' } }))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(withSetCookie(LOGIN_HTML, ['__Secure-typo3nonce_x=nonce123; path=/']))
      .mockResolvedValueOnce(withSetCookie(LOGIN_HTML, []))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getDgaAgSessionCookie()).rejects.toThrow(/session cookie/)
  })
})
