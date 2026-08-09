import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { getLlmKillSwitch, getLlmMaxTokens, getLlmProviderOverrideChain } from '~/server/utils/app-settings'
import { resolveActiveLlmConfigChain } from './translation-llm-chain'

vi.mock('~/server/utils/app-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/utils/app-settings')>()),
  getLlmProviderOverrideChain: vi.fn(),
  getLlmMaxTokens: vi.fn(),
  getLlmKillSwitch: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(getLlmProviderOverrideChain).mockResolvedValue([])
  vi.mocked(getLlmMaxTokens).mockResolvedValue(8192)
  vi.mocked(getLlmKillSwitch).mockResolvedValue(false)
  vi.stubGlobal('useRuntimeConfig', () => ({
    extractLlm: { provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt' },
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('resolveActiveLlmConfigChain', () => {
  it('falls back to the ENV default when nothing is assigned', async () => {
    const chain = await resolveActiveLlmConfigChain({} as Pool)
    expect(chain).toEqual([{ provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt', maxTokens: 8192 }])
  })

  it('returns an empty chain when the admin kill switch is on, without reading provider overrides', async () => {
    vi.mocked(getLlmKillSwitch).mockResolvedValue(true)

    await expect(resolveActiveLlmConfigChain({} as Pool)).resolves.toEqual([])
    expect(getLlmProviderOverrideChain).not.toHaveBeenCalled()
  })
})
