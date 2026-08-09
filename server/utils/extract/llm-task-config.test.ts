import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { getLlmKillSwitch, getLlmMaxTokens, getLlmProviderOverrideChain, getLlmProviderProfiles } from '../app-settings'
import { getPool } from '../db'
import { readExtractionLlmConfigChain, resolveLlmConfigForProfile } from './llm-task-config'

vi.mock('../app-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app-settings')>()),
  getLlmProviderProfiles: vi.fn(),
  getLlmProviderOverrideChain: vi.fn(),
  getLlmMaxTokens: vi.fn(),
  getLlmKillSwitch: vi.fn(),
}))

vi.mock('../db', () => ({
  getPool: vi.fn(),
}))

const PROFILE = {
  id: 'profile-1', name: 'DeepSeek via OpenRouter', provider: 'openrouter' as const,
  baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-pro', apiKey: 'secret', executionMode: 'sync' as const,
}

beforeEach(() => {
  vi.mocked(getLlmProviderProfiles).mockResolvedValue([PROFILE])
  vi.mocked(getLlmProviderOverrideChain).mockResolvedValue([])
  vi.mocked(getLlmMaxTokens).mockResolvedValue(4096)
  vi.mocked(getLlmKillSwitch).mockResolvedValue(false)
  vi.mocked(getPool).mockReturnValue({} as Pool)
  vi.stubGlobal('useRuntimeConfig', () => ({ extractLlm: undefined }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('resolveLlmConfigForProfile', () => {
  it('resolves a known profile into a single LlmConfig carrying its profileId', async () => {
    const config = await resolveLlmConfigForProfile({} as never, 'profile-1')

    expect(config).toEqual({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'secret',
      profileId: 'profile-1',
      model: 'deepseek/deepseek-v4-pro',
      maxTokens: 4096,
    })
  })

  it('returns null for an unknown profile id', async () => {
    await expect(resolveLlmConfigForProfile({} as never, 'nope')).resolves.toBeNull()
  })

  it('falls back to the default max-tokens on a lookup failure', async () => {
    vi.mocked(getLlmMaxTokens).mockRejectedValue(new Error('db down'))

    const config = await resolveLlmConfigForProfile({} as never, 'profile-1')

    expect(config?.maxTokens).toBeGreaterThan(0)
  })

  it('returns null when the admin kill switch is on, without resolving the profile', async () => {
    vi.mocked(getLlmKillSwitch).mockResolvedValue(true)

    await expect(resolveLlmConfigForProfile({} as never, 'profile-1')).resolves.toBeNull()
    expect(getLlmProviderProfiles).not.toHaveBeenCalled()
  })
})

describe('readExtractionLlmConfigChain', () => {
  it('resolves the assigned provider chain when the kill switch is off', async () => {
    vi.mocked(getLlmProviderOverrideChain).mockResolvedValue([{
      provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-pro', apiKey: 'secret', executionMode: 'sync',
    }])

    const chain = await readExtractionLlmConfigChain()

    expect(chain).toHaveLength(1)
    expect(chain[0]?.model).toBe('deepseek/deepseek-v4-pro')
  })

  it('returns an empty chain when the admin kill switch is on, without reading provider overrides', async () => {
    vi.mocked(getLlmKillSwitch).mockResolvedValue(true)

    await expect(readExtractionLlmConfigChain()).resolves.toEqual([])
    expect(getLlmProviderOverrideChain).not.toHaveBeenCalled()
  })

  it('resolves normally when no DB is configured (kill switch check is skipped)', async () => {
    vi.mocked(getPool).mockReturnValue(null)
    vi.stubGlobal('useRuntimeConfig', () => ({
      extractLlm: { provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt' },
    }))

    const chain = await readExtractionLlmConfigChain()

    expect(chain).toHaveLength(1)
    expect(getLlmKillSwitch).not.toHaveBeenCalled()
  })
})
