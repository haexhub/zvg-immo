import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLlmMaxTokens, getLlmProviderProfiles } from '../app-settings'
import { resolveLlmConfigForProfile } from './llm-task-config'

vi.mock('../app-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app-settings')>()),
  getLlmProviderProfiles: vi.fn(),
  getLlmMaxTokens: vi.fn(),
}))

const PROFILE = {
  id: 'profile-1', name: 'DeepSeek via OpenRouter', provider: 'openrouter' as const,
  baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-pro', apiKey: 'secret', executionMode: 'sync' as const,
}

beforeEach(() => {
  vi.mocked(getLlmProviderProfiles).mockResolvedValue([PROFILE])
  vi.mocked(getLlmMaxTokens).mockResolvedValue(4096)
})

afterEach(() => {
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
})
