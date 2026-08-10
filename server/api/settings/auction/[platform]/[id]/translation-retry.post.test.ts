import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'

vi.mock('~/server/utils/auction-record', () => ({ readAuctionRecord: vi.fn() }))
vi.mock('~/server/utils/db', () => ({ getPool: vi.fn() }))
vi.mock('~/server/utils/content-translation', () => ({
  claimAuctionTranslation: vi.fn(),
  completeAuctionTranslation: vi.fn(),
  failAuctionTranslation: vi.fn(),
  readContentTranslation: vi.fn(),
  writeContentTranslation: vi.fn(),
}))
vi.mock('~/server/utils/translation-llm-chain', () => ({
  resolveActiveLlmConfigChain: vi.fn(),
  fingerprintConfigChain: vi.fn(() => 'fingerprint'),
}))
vi.mock('~/server/utils/extract/llm', () => ({ isLlmProviderUnavailable: vi.fn(() => false) }))
vi.mock('~/server/api/auction/[platform]/[id]/translation.post', () => ({
  SUPPORTED_TARGET_LANGS: new Set(['de', 'en']),
  auctionTranslationContentHash: vi.fn(() => 'content-hash'),
  tryTranslate: vi.fn(),
}))

const CLAIM = { startedAt: new Date('2026-08-10T10:00:00.000Z') }

function auction(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'se-kronofogden',
    country: 'se',
    externalId: '101738',
    title: 'Haus',
    address: null,
    description: null,
    extraction: undefined,
    ...overrides,
  } as never
}

async function loadHandler() {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
  return (await import('./translation-retry.post')).default as unknown as (event: {
    context: { params: { platform: string; id: string } }
  }) => Promise<unknown>
}

function event(platform: string, id: string) {
  return {
    context: { params: { platform, id } },
  } as never
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/auction/[platform]/[id]/translation-retry', () => {
  it('rejects an unsafe platform/id segment', async () => {
    vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => (name === 'platform' ? '../etc' : '1'))
    vi.stubGlobal('readBody', async () => ({ lang: 'de' }))
    const handler = await loadHandler()

    await expect(handler(event('../etc', '1'))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects an unsupported lang', async () => {
    vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => (name === 'platform' ? 'se-kronofogden' : '101738'))
    vi.stubGlobal('readBody', async () => ({ lang: 'fr' }))
    const handler = await loadHandler()

    await expect(handler(event('se-kronofogden', '101738'))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s when the auction has no versioned details yet', async () => {
    vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => (name === 'platform' ? 'se-kronofogden' : '101738'))
    vi.stubGlobal('readBody', async () => ({ lang: 'de' }))
    const { readAuctionRecord } = await import('~/server/utils/auction-record')
    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({} as Pool)
    vi.mocked(readAuctionRecord).mockResolvedValue({ auction: auction(), detailsId: null, detailsVersion: null, artifactVersionId: null })
    const handler = await loadHandler()

    await expect(handler(event('se-kronofogden', '101738'))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('409s when another attempt already holds the claim', async () => {
    vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => (name === 'platform' ? 'se-kronofogden' : '101738'))
    vi.stubGlobal('readBody', async () => ({ lang: 'de' }))
    const { readAuctionRecord } = await import('~/server/utils/auction-record')
    const { getPool } = await import('~/server/utils/db')
    const { claimAuctionTranslation } = await import('~/server/utils/content-translation')
    vi.mocked(getPool).mockReturnValue({} as Pool)
    vi.mocked(readAuctionRecord).mockResolvedValue({ auction: auction(), detailsId: 1, detailsVersion: 1, artifactVersionId: null })
    vi.mocked(claimAuctionTranslation).mockResolvedValue(null)
    const handler = await loadHandler()

    await expect(handler(event('se-kronofogden', '101738'))).rejects.toMatchObject({ statusCode: 409 })
  })

  it('claims immediately without checking the failed-attempt backoff, then persists a successful retry in the background', async () => {
    vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => (name === 'platform' ? 'se-kronofogden' : '101738'))
    vi.stubGlobal('readBody', async () => ({ lang: 'de' }))
    const { readAuctionRecord } = await import('~/server/utils/auction-record')
    const { getPool } = await import('~/server/utils/db')
    const { claimAuctionTranslation, completeAuctionTranslation, readContentTranslation } = await import('~/server/utils/content-translation')
    const { resolveActiveLlmConfigChain } = await import('~/server/utils/translation-llm-chain')
    const { tryTranslate } = await import('~/server/api/auction/[platform]/[id]/translation.post')
    vi.mocked(getPool).mockReturnValue({} as Pool)
    vi.mocked(readAuctionRecord).mockResolvedValue({ auction: auction(), detailsId: 1, detailsVersion: 1, artifactVersionId: null })
    vi.mocked(claimAuctionTranslation).mockResolvedValue(CLAIM)
    vi.mocked(readContentTranslation).mockResolvedValue(null)
    vi.mocked(resolveActiveLlmConfigChain).mockResolvedValue([{ provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt', maxTokens: 8192 }])
    const payload = { title: 'Retried title', address: null, description: null, documentSummary: null, extractionTexts: null }
    vi.mocked(tryTranslate).mockResolvedValue(payload)
    const handler = await loadHandler()

    await expect(handler(event('se-kronofogden', '101738'))).resolves.toEqual({ started: true })
    expect(claimAuctionTranslation).toHaveBeenCalledWith(expect.anything(), 'se-kronofogden', '101738', 1, 'de', 'content-hash')

    await vi.waitFor(() => expect(completeAuctionTranslation).toHaveBeenCalledWith(
      expect.anything(), 'se-kronofogden', '101738', 1, 'de', CLAIM, payload,
    ))
  })

  it('records the failure via failAuctionTranslation when every configured model fails', async () => {
    vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => (name === 'platform' ? 'se-kronofogden' : '101738'))
    vi.stubGlobal('readBody', async () => ({ lang: 'de' }))
    const { readAuctionRecord } = await import('~/server/utils/auction-record')
    const { getPool } = await import('~/server/utils/db')
    const { claimAuctionTranslation, failAuctionTranslation, readContentTranslation } = await import('~/server/utils/content-translation')
    const { resolveActiveLlmConfigChain } = await import('~/server/utils/translation-llm-chain')
    const { tryTranslate } = await import('~/server/api/auction/[platform]/[id]/translation.post')
    vi.mocked(getPool).mockReturnValue({} as Pool)
    vi.mocked(readAuctionRecord).mockResolvedValue({ auction: auction(), detailsId: 1, detailsVersion: 1, artifactVersionId: null })
    vi.mocked(claimAuctionTranslation).mockResolvedValue(CLAIM)
    vi.mocked(readContentTranslation).mockResolvedValue(null)
    vi.mocked(resolveActiveLlmConfigChain).mockResolvedValue([{ provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt', maxTokens: 8192 }])
    vi.mocked(tryTranslate).mockRejectedValue(new Error('provider down'))
    const handler = await loadHandler()

    await expect(handler(event('se-kronofogden', '101738'))).resolves.toEqual({ started: true })

    await vi.waitFor(() => expect(failAuctionTranslation).toHaveBeenCalledWith(
      expect.anything(), 'se-kronofogden', '101738', 1, 'de', CLAIM, 'provider down', 'fingerprint',
    ))
  })
})
