import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type { Auction } from '~/types/auction'
import type { InsightDefinition } from '~/server/utils/insights/registry'

vi.mock('h3', () => ({
  setResponseHeader: vi.fn(),
}))

vi.mock('~/server/utils/auction-record', () => ({
  readAuctionRecord: vi.fn(),
}))

vi.mock('~/server/utils/db', () => ({
  getPool: vi.fn(),
}))

vi.mock('~/server/utils/insight-cache', () => ({
  readInsight: vi.fn(),
  writeInsight: vi.fn(),
}))

vi.mock('~/server/utils/app-settings', () => ({
  getLlmMaxTokens: vi.fn(),
  getLlmProviderOverride: vi.fn(),
}))

vi.mock('~/server/utils/extract/llm', () => ({
  resolveLlmConfig: vi.fn(),
  getProvider: vi.fn(),
}))

vi.mock('~/server/utils/insights/registry', () => ({
  getInsightDefinition: vi.fn(),
}))

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'se-kronofogden',
    country: 'se',
    region: 'Gävleborg',
    externalId: '101738',
    caseNumber: 'F-3020-25',
    authority: 'Kronofogden',
    title: 'Småhusenhet, bebyggd',
    address: 'Nor Kasernvägen 5, 827 54 Järvsö',
    marketValueEur: 138_078,
    marketValueText: '1525000:- SEK',
    auctionDateIso: '2026-08-19',
    auctionDateText: '2026-08-19',
    cancelled: false,
    sourceUpdatedIso: null,
    pdfUrl: null,
    detailUrl: null,
    pdfUrlUpstream: null,
    detailUrlUpstream: null,
    attachments: [],
    description: 'Storlek: 5 rum, 124 kvm',
    photoCount: 0,
    thumbnailUrl: null,
    extraction: {
      propertyType: 'einfamilienhaus',
      landAreaSqm: 1775,
      livingAreaSqm: 124,
      rooms: 5,
      units: null,
      source: 'rules',
      confidence: 'high',
    },
    ...overrides,
  } as Auction
}

type InsightHandler = (event: {
  context: { params: { platform: string, id: string, insightId: string } }
  node: { req: { socket: { remoteAddress: string } } }
}) => Promise<unknown>

function testDefinition(overrides: Partial<InsightDefinition<unknown>> = {}): InsightDefinition<unknown> {
  return {
    id: 'usage-ideas',
    maxTokensDefault: 1536,
    rateLimitPerHourPerIp: 20,
    promptVersion: 1,
    buildContentHashInput: () => ({ propertyType: 'einfamilienhaus' }),
    buildPrompt: () => ({ systemPrompt: 'system', userText: 'user' }),
    schema: { type: 'object' },
    clamp: (raw) => (raw && typeof raw === 'object' ? raw : null),
    ...overrides,
  }
}

async function loadHandler() {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRequestHeader', () => undefined)
  vi.stubGlobal('useRuntimeConfig', () => ({
    trustForwardedFor: '0',
    extractLlm: { provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt' },
  }))
  vi.stubGlobal('createError', (input: { statusCode: number, statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

  const { readAuctionRecord } = await import('~/server/utils/auction-record')
  const { getPool } = await import('~/server/utils/db')
  const { readInsight, writeInsight } = await import('~/server/utils/insight-cache')
  const { getLlmMaxTokens, getLlmProviderOverride } = await import('~/server/utils/app-settings')
  const { resolveLlmConfig, getProvider } = await import('~/server/utils/extract/llm')

  vi.mocked(readAuctionRecord).mockResolvedValue({
    auction: auction(),
    detailsId: 1,
    detailsVersion: 1,
    artifactVersionId: null,
  })
  vi.mocked(getPool).mockReturnValue({} as Pool)
  vi.mocked(readInsight).mockResolvedValue(null)
  vi.mocked(writeInsight).mockResolvedValue(undefined)
  vi.mocked(getLlmProviderOverride).mockResolvedValue(null)
  vi.mocked(getLlmMaxTokens).mockResolvedValue(1536)
  vi.mocked(resolveLlmConfig).mockReturnValue({
    provider: 'openai-compatible',
    baseUrl: 'https://api.example',
    model: 'gpt',
    maxTokens: 1536,
  })
  vi.mocked(getProvider).mockReturnValue({ extract: vi.fn() })

  const handler = (await import('./[insightId].post')).default as unknown as InsightHandler

  return {
    handler,
    readInsight: vi.mocked(readInsight),
    writeInsight: vi.mocked(writeInsight),
    resolveLlmConfig: vi.mocked(resolveLlmConfig),
    getProvider: vi.mocked(getProvider),
  }
}

function callHandler(handler: InsightHandler, insightId: string, remoteAddress = '127.0.0.1') {
  return handler({
    context: { params: { platform: 'se-kronofogden', id: '101738', insightId } },
    node: { req: { socket: { remoteAddress } } },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/auction/:platform/:id/insight/:insightId', () => {
  it('returns 404 for an unknown insightId', async () => {
    const { getInsightDefinition } = await import('~/server/utils/insights/registry')
    vi.mocked(getInsightDefinition).mockReturnValue(undefined)
    const { handler } = await loadHandler()

    await expect(callHandler(handler, 'does-not-exist')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('serves a cache hit without calling the LLM', async () => {
    const { getInsightDefinition } = await import('~/server/utils/insights/registry')
    vi.mocked(getInsightDefinition).mockReturnValue(testDefinition())
    const { handler, readInsight, getProvider } = await loadHandler()
    readInsight.mockResolvedValue({ payload: [{ type: 'owner-occupation' }], at: '2026-07-29T00:00:00.000Z' })

    await expect(callHandler(handler, 'usage-ideas')).resolves.toEqual({
      payload: [{ type: 'owner-occupation' }],
      at: '2026-07-29T00:00:00.000Z',
    })
    expect(getProvider).not.toHaveBeenCalled()
  })

  it('generates and writes through on a cache miss', async () => {
    const { getInsightDefinition } = await import('~/server/utils/insights/registry')
    vi.mocked(getInsightDefinition).mockReturnValue(testDefinition())
    const { handler, writeInsight, getProvider } = await loadHandler()
    const extract = vi.fn().mockResolvedValue({ ideas: [{ type: 'owner-occupation' }] })
    getProvider.mockReturnValue({ extract })

    const result = await callHandler(handler, 'usage-ideas') as { payload: unknown, at: string }
    expect(result.payload).toEqual({ ideas: [{ type: 'owner-occupation' }] })
    expect(writeInsight).toHaveBeenCalledWith(expect.anything(), 'usage-ideas', expect.any(String), result.payload)
  })

  it('returns 502 and writes nothing when clamp() rejects the LLM output', async () => {
    const { getInsightDefinition } = await import('~/server/utils/insights/registry')
    vi.mocked(getInsightDefinition).mockReturnValue(testDefinition({ clamp: () => null }))
    const { handler, writeInsight, getProvider } = await loadHandler()
    getProvider.mockReturnValue({ extract: vi.fn().mockResolvedValue({ garbage: true }) })

    await expect(callHandler(handler, 'usage-ideas')).rejects.toMatchObject({ statusCode: 502 })
    expect(writeInsight).not.toHaveBeenCalled()
  })

  it('returns 503 when the LLM is not configured', async () => {
    const { getInsightDefinition } = await import('~/server/utils/insights/registry')
    vi.mocked(getInsightDefinition).mockReturnValue(testDefinition())
    const { handler, resolveLlmConfig } = await loadHandler()
    resolveLlmConfig.mockReturnValue(null)

    await expect(callHandler(handler, 'usage-ideas')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('deduplicates two concurrent requests for the same insight+content-hash', async () => {
    const { getInsightDefinition } = await import('~/server/utils/insights/registry')
    vi.mocked(getInsightDefinition).mockReturnValue(testDefinition())
    const { handler, writeInsight, getProvider } = await loadHandler()

    let resolveExtract!: (value: unknown) => void
    const deferred = new Promise((resolve) => { resolveExtract = resolve })
    const extract = vi.fn().mockReturnValue(deferred)
    getProvider.mockReturnValue({ extract })

    const first = callHandler(handler, 'usage-ideas')
    const second = callHandler(handler, 'usage-ideas')
    resolveExtract({ ideas: [{ type: 'owner-occupation' }] })

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)
    expect(extract).toHaveBeenCalledTimes(1)
    expect(writeInsight).toHaveBeenCalledTimes(1)
  })

  it('rate-limits per insightId independently, so one insight cannot exhaust another\'s budget', async () => {
    const { getInsightDefinition } = await import('~/server/utils/insights/registry')
    const definitions: Record<string, InsightDefinition<unknown>> = {
      'insight-a': testDefinition({ id: 'insight-a', rateLimitPerHourPerIp: 1 }),
      'insight-b': testDefinition({ id: 'insight-b', rateLimitPerHourPerIp: 1 }),
    }
    vi.mocked(getInsightDefinition).mockImplementation((id: string) => definitions[id])
    const { handler, getProvider } = await loadHandler()
    getProvider.mockReturnValue({ extract: vi.fn().mockResolvedValue({ ok: true }) })

    await expect(callHandler(handler, 'insight-a')).resolves.toBeDefined()
    await expect(callHandler(handler, 'insight-a')).rejects.toMatchObject({ statusCode: 429 })
    // Same client, different insight: must not be affected by insight-a's limit.
    await expect(callHandler(handler, 'insight-b')).resolves.toBeDefined()
  })
})
