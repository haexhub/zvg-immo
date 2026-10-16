import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn() }))
vi.mock('~/server/utils/app-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/app-settings')>()
  return {
    ...actual,
    getLlmProviderOverride: vi.fn(),
    getLlmProviderProfileSettings: vi.fn(),
    getLlmExtractionChainStrategy: vi.fn(),
  }
})

function stubGlobals(): void {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('useRuntimeConfig', () => ({
    extractLlm: { provider: 'openai-compatible', baseUrl: 'http://env-default:8080', model: 'env-model' },
  }))
}

async function loadHandler() {
  return (await import('./llm-profiles.get')).default as unknown as () => Promise<{
    effective: Record<string, { provider: string; baseUrl: string; model: string; executionMode: string }>
    scopes: string[]
  }>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('GET /api/settings/llm-profiles', () => {
  it('reports the env default for every scope when no DB is configured', async () => {
    stubGlobals()
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue(null)

    const res = await (await loadHandler())()
    for (const scope of res.scopes) {
      expect(res.effective[scope]).toMatchObject({ provider: 'openai-compatible', baseUrl: 'http://env-default:8080' })
    }
  })
})
