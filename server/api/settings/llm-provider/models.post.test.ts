import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
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
