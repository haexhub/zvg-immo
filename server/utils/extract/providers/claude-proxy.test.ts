import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionRequest } from '../llm'
import { ClaudeProxyProvider } from './claude-proxy'

describe('ClaudeProxyProvider.extract', () => {
  const config = { baseUrl: 'https://proxy.example', apiKey: 'k', model: 'claude-haiku-4-5' }
  const req: ExtractionRequest = { systemPrompt: 'p', schema: {}, parts: [{ type: 'text', text: 'hi' }] }

  function error(status: number) {
    return Object.assign(new Error(`http ${status}`), { response: { status } })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rethrows a 429 instead of returning null, so it is not counted toward the retry-lockout', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(error(429)))
    const provider = new ClaudeProxyProvider(config)
    await expect(provider.extract(req)).rejects.toThrow('http 429')
  })

  it('returns null for a non-429 request failure', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(error(500)))
    const provider = new ClaudeProxyProvider(config)
    await expect(provider.extract(req)).resolves.toBeNull()
  })
})
