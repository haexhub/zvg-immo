import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('fetchOpenRouterModels', () => {
  async function importModule() {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    return import('./models.post')
  }

  it('requests only structured_outputs-capable models and maps them', async () => {
    const { fetchOpenRouterModels } = await importModule()
    const fetchMock = vi.fn().mockResolvedValue({
      data: [
        { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B' },
        { id: 'no-label/model', name: undefined },
      ],
    })
    vi.stubGlobal('$fetch', fetchMock)

    const models = await fetchOpenRouterModels('https://openrouter.ai/api/v1')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ query: { supported_parameters: 'structured_outputs' } }),
    )
    expect(models).toEqual([
      { id: 'openai/gpt-oss-120b', label: 'GPT OSS 120B' },
      { id: 'no-label/model', label: 'no-label/model' },
    ])
  })

  it('strips a trailing slash from the base URL before appending /models', async () => {
    const { fetchOpenRouterModels } = await importModule()
    const fetchMock = vi.fn().mockResolvedValue({ data: [] })
    vi.stubGlobal('$fetch', fetchMock)

    await fetchOpenRouterModels('https://openrouter.ai/api/v1/')

    expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', expect.anything())
  })
})

describe('/api/settings/llm-provider/models POST upstream failures', () => {
  async function importHandler(body: Record<string, unknown>) {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', async () => body)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string; cause?: unknown }) => Object.assign(new Error(input.statusMessage), input))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    return (await import('./models.post')).default as unknown as (event: unknown) => Promise<unknown>
  }

  it('reports a rejected API key as such, keeps the cause and stays 502', async () => {
    const upstream = Object.assign(new Error('Forbidden'), { statusCode: 403 })
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(upstream))
    const handler = await importHandler({ provider: 'gemini-native', apiKey: 'bad-key' })

    await expect(handler({})).rejects.toMatchObject({
      statusCode: 502,
      statusMessage: expect.stringContaining('API-Key abgelehnt'),
      cause: upstream,
    })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Gemini-API'), upstream)
  })

  it('keeps the "not reachable" message for transport errors without a status', async () => {
    const upstream = new TypeError('fetch failed')
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(upstream))
    const handler = await importHandler({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' })

    await expect(handler({})).rejects.toMatchObject({
      statusCode: 502,
      statusMessage: expect.stringContaining('OpenRouter nicht erreichbar'),
      cause: upstream,
    })
  })
})
