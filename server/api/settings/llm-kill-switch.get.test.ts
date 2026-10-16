import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn(() => ({})) }))
vi.mock('~/server/utils/app-settings', () => ({ DEFAULT_LLM_KILL_SWITCH: false, readLlmKillSwitch: vi.fn(async () => false) }))

type Handler = () => Promise<unknown>

async function loadHandler(): Promise<Handler> {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
  return (await import('./llm-kill-switch.get')).default as unknown as Handler
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('GET /api/settings/llm-kill-switch', () => {
  it('returns the stored switch', async () => {
    const handler = await loadHandler()
    await expect(handler()).resolves.toEqual({ enabled: false })
  })

  it('503s on a read error instead of reporting the fail-closed "on"', async () => {
    const handler = await loadHandler()
    const { readLlmKillSwitch } = await import('~/server/utils/app-settings')
    vi.mocked(readLlmKillSwitch).mockRejectedValueOnce(new Error('db down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(handler()).rejects.toMatchObject({ statusCode: 503 })
  })
})
