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

const EXTRACTION_OVERRIDE = {
  provider: 'gemini-native' as const,
  baseUrl: 'https://generativelanguage.googleapis.com',
  model: 'gemini-2.5-pro',
  executionMode: 'sync' as const,
  apiKey: 'k',
}

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

  // An insight without its own chain runs on extraction's resolved config
  // (insight/[insightId].post.ts falls back to it), so the card must not print
  // the env default next to its "uses document extraction's provider" hint.
  it('mirrors extraction onto insight scopes that have no override of their own', async () => {
    stubGlobals()
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({} as never)
    const settings = await import('~/server/utils/app-settings')
    vi.mocked(settings.getLlmProviderProfileSettings).mockResolvedValue({ profiles: [], assignments: {} })
    vi.mocked(settings.getLlmExtractionChainStrategy).mockResolvedValue('fallback')
    vi.mocked(settings.getLlmProviderOverride).mockImplementation(async (_db, scope) =>
      scope === 'extraction' ? EXTRACTION_OVERRIDE : null,
    )

    const res = await (await loadHandler())()
    const insightScopes = res.scopes.filter((scope) => scope !== 'extraction' && scope !== 'translation')
    expect(insightScopes.length).toBeGreaterThan(0)
    for (const scope of insightScopes) {
      expect(res.effective[scope]).toEqual(res.effective.extraction)
      expect(res.effective[scope]).toMatchObject({ provider: 'gemini-native', model: 'gemini-2.5-pro' })
    }
    // translation keeps its own env-default fallback, it does not ride extraction
    expect(res.effective.translation).toMatchObject({ provider: 'openai-compatible', model: 'env-model' })
  })

  it('keeps an insight scope that has its own override', async () => {
    stubGlobals()
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({} as never)
    const settings = await import('~/server/utils/app-settings')
    vi.mocked(settings.getLlmProviderProfileSettings).mockResolvedValue({ profiles: [], assignments: {} })
    vi.mocked(settings.getLlmExtractionChainStrategy).mockResolvedValue('fallback')
    vi.mocked(settings.getLlmProviderOverride).mockImplementation(async (_db, scope) => {
      if (scope === 'extraction') return EXTRACTION_OVERRIDE
      if (scope === 'usage-ideas') return { ...EXTRACTION_OVERRIDE, model: 'gemini-2.5-flash' }
      return null
    })

    const res = await (await loadHandler())()
    expect(res.effective['usage-ideas']).toMatchObject({ model: 'gemini-2.5-flash' })
    expect(res.effective.extraction).toMatchObject({ model: 'gemini-2.5-pro' })
  })
})
