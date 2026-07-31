import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn() }))
vi.mock('~/server/utils/place-name-translation', () => ({
  readPlaceNameTranslations: vi.fn(),
  writePlaceNameTranslations: vi.fn(),
}))
vi.mock('~/server/utils/translation-llm-chain', () => ({
  resolveActiveLlmConfigChain: vi.fn(),
}))
vi.mock('~/server/utils/extract/text-llm', () => ({
  callPlaceNameTranslationLlm: vi.fn(),
}))

const CONFIG = { provider: 'openai-compatible' as const, baseUrl: 'https://api.example', model: 'gpt' }

async function loadHandler(body: Record<string, unknown>) {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('readBody', async () => body)
  vi.stubGlobal('getRequestHeader', () => undefined)
  vi.stubGlobal('useRuntimeConfig', () => ({ trustForwardedFor: '0' }))
  vi.stubGlobal('createError', (input: { statusCode: number, statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

  const { getPool } = await import('~/server/utils/db')
  const { readPlaceNameTranslations, writePlaceNameTranslations } = await import('~/server/utils/place-name-translation')
  const { resolveActiveLlmConfigChain } = await import('~/server/utils/translation-llm-chain')

  vi.mocked(getPool).mockReturnValue({} as Pool)
  vi.mocked(readPlaceNameTranslations).mockResolvedValue(new Map())
  vi.mocked(writePlaceNameTranslations).mockResolvedValue(undefined)
  vi.mocked(resolveActiveLlmConfigChain).mockResolvedValue([CONFIG])

  return (await import('./translate.post')).default as unknown as (event: {
    node: { req: { socket: { remoteAddress: string } } }
  }) => Promise<unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/place-names/translate', () => {
  it('rejects an invalid or missing lang', async () => {
    const handler = await loadHandler({ names: ['Бургас'], lang: 'fr' })
    await expect(handler({ node: { req: { socket: { remoteAddress: '127.0.0.1' } } } })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns an empty map for an empty/missing names list without touching the cache or LLM', async () => {
    const handler = await loadHandler({ names: [], lang: 'en' })
    const { readPlaceNameTranslations } = await import('~/server/utils/place-name-translation')
    await expect(handler({ node: { req: { socket: { remoteAddress: '127.0.0.1' } } } })).resolves.toEqual({ translations: {} })
    expect(readPlaceNameTranslations).not.toHaveBeenCalled()
  })

  it('serves fully cached names without calling the LLM', async () => {
    const handler = await loadHandler({ names: ['Бургас'], lang: 'en' })
    const { readPlaceNameTranslations } = await import('~/server/utils/place-name-translation')
    const { callPlaceNameTranslationLlm } = await import('~/server/utils/extract/text-llm')
    vi.mocked(readPlaceNameTranslations).mockResolvedValue(new Map([['Бургас', 'Burgas']]))

    await expect(handler({ node: { req: { socket: { remoteAddress: '127.0.0.1' } } } }))
      .resolves.toEqual({ translations: { 'Бургас': 'Burgas' } })
    expect(callPlaceNameTranslationLlm).not.toHaveBeenCalled()
  })

  it('translates cache misses, writes them back, and merges with cached hits', async () => {
    const handler = await loadHandler({ names: ['Бургас', 'с. Равна'], lang: 'en' })
    const { readPlaceNameTranslations, writePlaceNameTranslations } = await import('~/server/utils/place-name-translation')
    const { callPlaceNameTranslationLlm } = await import('~/server/utils/extract/text-llm')
    vi.mocked(readPlaceNameTranslations).mockResolvedValue(new Map([['Бургас', 'Burgas']]))
    vi.mocked(callPlaceNameTranslationLlm).mockResolvedValue(['Ravna'])

    await expect(handler({ node: { req: { socket: { remoteAddress: '127.0.0.1' } } } }))
      .resolves.toEqual({ translations: { 'Бургас': 'Burgas', 'с. Равна': 'Ravna' } })
    expect(callPlaceNameTranslationLlm).toHaveBeenCalledWith(['с. Равна'], 'English', CONFIG)
    expect(writePlaceNameTranslations).toHaveBeenCalledWith(
      expect.anything(), 'en', [{ name: 'с. Равна', translated: 'Ravna' }],
    )
  })

  it('degrades to cached-only results when the LLM is unavailable, without throwing', async () => {
    const handler = await loadHandler({ names: ['Бургас', 'с. Равна'], lang: 'en' })
    const { readPlaceNameTranslations, writePlaceNameTranslations } = await import('~/server/utils/place-name-translation')
    const { callPlaceNameTranslationLlm } = await import('~/server/utils/extract/text-llm')
    vi.mocked(readPlaceNameTranslations).mockResolvedValue(new Map([['Бургас', 'Burgas']]))
    vi.mocked(callPlaceNameTranslationLlm).mockResolvedValue(null)

    await expect(handler({ node: { req: { socket: { remoteAddress: '127.0.0.1' } } } }))
      .resolves.toEqual({ translations: { 'Бургас': 'Burgas' } })
    expect(writePlaceNameTranslations).not.toHaveBeenCalled()
  })

  it('moves on to the next configured provider when one throws', async () => {
    const handler = await loadHandler({ names: ['с. Равна'], lang: 'en' })
    const { resolveActiveLlmConfigChain } = await import('~/server/utils/translation-llm-chain')
    const { callPlaceNameTranslationLlm } = await import('~/server/utils/extract/text-llm')
    const fallbackConfig = { ...CONFIG, model: 'gpt-fallback' }
    vi.mocked(resolveActiveLlmConfigChain).mockResolvedValue([CONFIG, fallbackConfig])
    vi.mocked(callPlaceNameTranslationLlm)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(['Ravna'])

    await expect(handler({ node: { req: { socket: { remoteAddress: '127.0.0.1' } } } }))
      .resolves.toEqual({ translations: { 'с. Равна': 'Ravna' } })
    expect(callPlaceNameTranslationLlm).toHaveBeenCalledTimes(2)
    expect(vi.mocked(callPlaceNameTranslationLlm).mock.calls[1]![2]).toEqual(fallbackConfig)
  })

  it('deduplicates and caps the incoming names list', async () => {
    const { readPlaceNameTranslations } = await import('~/server/utils/place-name-translation')
    const handler = await loadHandler({ names: ['Бургас', 'Бургас', ...Array.from({ length: 50 }, (_, i) => `Place ${i}`)], lang: 'en' })

    await handler({ node: { req: { socket: { remoteAddress: '127.0.0.1' } } } })

    const [, namesArg] = vi.mocked(readPlaceNameTranslations).mock.calls[0]!
    expect(namesArg.length).toBeLessThanOrEqual(40)
    expect(new Set(namesArg).size).toBe(namesArg.length)
  })

  it('fails visibly when the serving database is not configured', async () => {
    const handler = await loadHandler({ names: ['Бургас'], lang: 'en' })
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue(null)
    await expect(handler({ node: { req: { socket: { remoteAddress: '127.0.0.1' } } } })).rejects.toMatchObject({ statusCode: 503 })
  })
})
