import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/db', () => ({ getPool: vi.fn(() => ({})) }))
vi.mock('../../utils/app-settings', () => ({
  KINDS: ['extraction', 'translation'],
  setLlmMaxTokens: vi.fn(async () => {}),
  getAllLlmMaxTokens: vi.fn(async () => ({ extraction: 4096, translation: 8192 })),
}))

async function loadHandler(body: unknown) {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('readBody', vi.fn(async () => body))
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
  return (await import('./llm-config.put')).default as unknown as (event: unknown) => Promise<unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/llm-config PUT', () => {
  it('writes nothing when a later kind is invalid', async () => {
    const handler = await loadHandler({ extraction: 64000, translation: 'abc' })
    const { setLlmMaxTokens } = await import('../../utils/app-settings')

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
    expect(setLlmMaxTokens).not.toHaveBeenCalled()
  })

  it('writes every kind once all are valid', async () => {
    const handler = await loadHandler({ extraction: 6000, translation: 9000 })
    const { setLlmMaxTokens } = await import('../../utils/app-settings')

    await expect(handler({})).resolves.toEqual({ extraction: 4096, translation: 8192 })
    expect(setLlmMaxTokens).toHaveBeenCalledWith({}, 'extraction', 6000)
    expect(setLlmMaxTokens).toHaveBeenCalledWith({}, 'translation', 9000)
  })
})
