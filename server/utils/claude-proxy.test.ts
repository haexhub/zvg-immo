import { afterEach, describe, expect, it, vi } from 'vitest'

/** Stub the proxy's Nuxt globals so every fetch rejects with the supplied error. */
function stubProxy(fetchError: unknown) {
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
  vi.stubGlobal('useRuntimeConfig', () => ({ claudeProxyUrl: 'http://proxy:8080', proxySetupToken: 'token' }))
  vi.stubGlobal('$fetch', vi.fn(async () => { throw fetchError }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('callProxySetup', () => {
  it.each([401, 403])('maps an upstream %i to 502 so the settings session is not expired', async (statusCode) => {
    stubProxy({ statusCode, data: { statusMessage: 'invalid setup token' } })
    const { callProxySetup } = await import('./claude-proxy')

    await expect(callProxySetup('GET', '/status')).rejects.toMatchObject({
      statusCode: 502,
      statusMessage: 'Claude-Proxy: invalid setup token',
    })
  })

  it('forwards other upstream statuses unchanged', async () => {
    stubProxy({ statusCode: 409, data: { statusMessage: 'flow already running' } })
    const { callProxySetup } = await import('./claude-proxy')

    await expect(callProxySetup('POST', '/login')).rejects.toMatchObject({ statusCode: 409 })
  })

  it('falls back to 502 when the proxy is unreachable', async () => {
    stubProxy(new Error('fetch failed'))
    const { callProxySetup } = await import('./claude-proxy')

    await expect(callProxySetup('GET', '/status')).rejects.toMatchObject({
      statusCode: 502,
      statusMessage: 'Claude-Proxy: Proxy nicht erreichbar.',
    })
  })
})
