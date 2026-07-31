import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type { Auction } from '~/types/auction'

vi.mock('h3', () => ({
  setResponseHeader: vi.fn(),
  setResponseStatus: vi.fn(),
}))

vi.mock('~/server/utils/auction-snapshot', () => ({
  readAuctionSnapshot: vi.fn(),
}))

vi.mock('~/server/utils/db', () => ({
  getPool: vi.fn(),
}))

vi.mock('~/server/utils/content-translation', () => ({
  readAuctionTranslation: vi.fn(),
  claimAuctionTranslation: vi.fn(),
  completeAuctionTranslation: vi.fn(),
  failAuctionTranslation: vi.fn(),
  readContentTranslation: vi.fn(),
  writeContentTranslation: vi.fn(),
}))

vi.mock('~/server/utils/app-settings', () => ({
  getLlmMaxTokens: vi.fn(),
  getLlmProviderOverride: vi.fn(),
  getLlmProviderOverrideChain: vi.fn(),
}))

vi.mock('~/server/utils/extract/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/extract/llm')>()
  return { ...actual, resolveLlmConfig: vi.fn() }
})

vi.mock('~/server/utils/extract/text-llm', () => ({
  callTranslationLlm: vi.fn(),
}))

/** Ownership token claimAuctionTranslation hands back (its row's started_at). */
const CLAIM = { startedAt: new Date('2026-07-29T10:00:00.000Z') }

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
      at: '2026-07-28T21:37:21.834Z',
      insights: {
        defects: [],
        encumbrances: ['Utmätning (Pfändung) 2025-11-10'],
        landValueEurPerSqm: null,
        construction: 'Holzkonstruktion mit Kriechkeller, Holzverkleidung (Träpanel)',
        locationCharacter: 'Gles bebyggelse, ländliche Umgebung',
        summary: null,
      },
      planningNotes: {
        monumentProtection: null,
        contamination: 'Värderingsobjektet är inte registrerat i Länsstyrelsens register.',
        developmentPlan: 'Värderingsobjektet är beläget inom planlagt område.',
        landConsolidation: null,
        developmentCharges: null,
        redevelopmentArea: null,
        conservationArea: null,
        landParcels: [{ label: 'Ljusdal Nor 1:5', areaSqm: 1775, use: 'Småhusenhet, bebyggd' }],
      },
      documentSetHash: 'doc-hash',
      documentSetVersion: 1,
    },
    ...overrides,
  }
}

async function loadHandler(query: Record<string, string> = { lang: 'de' }) {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getQuery', () => query)
  vi.stubGlobal('getRequestHeader', () => undefined)
  vi.stubGlobal('useRuntimeConfig', () => ({
    trustForwardedFor: '0',
    extractLlm: { provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt' },
  }))
  vi.stubGlobal('createError', (input: { statusCode: number, statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

  const { readAuctionSnapshot } = await import('~/server/utils/auction-snapshot')
  const { getPool } = await import('~/server/utils/db')
  const {
    readAuctionTranslation,
    claimAuctionTranslation,
    completeAuctionTranslation,
    failAuctionTranslation,
    readContentTranslation,
    writeContentTranslation,
  } = await import('~/server/utils/content-translation')
  const { getLlmMaxTokens, getLlmProviderOverride, getLlmProviderOverrideChain } = await import('~/server/utils/app-settings')
  const { resolveLlmConfig } = await import('~/server/utils/extract/llm')

  vi.mocked(readAuctionSnapshot).mockResolvedValue({ 'se-kronofogden:101738': auction() })
  vi.mocked(getPool).mockReturnValue({} as Pool)
  vi.mocked(readAuctionTranslation).mockResolvedValue(null)
  vi.mocked(claimAuctionTranslation).mockResolvedValue(CLAIM)
  vi.mocked(completeAuctionTranslation).mockResolvedValue(undefined)
  vi.mocked(failAuctionTranslation).mockResolvedValue(undefined)
  vi.mocked(readContentTranslation).mockResolvedValue(null)
  vi.mocked(writeContentTranslation).mockResolvedValue(undefined)
  vi.mocked(getLlmProviderOverride).mockResolvedValue(null)
  vi.mocked(getLlmProviderOverrideChain).mockResolvedValue([])
  vi.mocked(getLlmMaxTokens).mockResolvedValue(8192)
  vi.mocked(resolveLlmConfig).mockReturnValue({
    provider: 'openai-compatible',
    baseUrl: 'https://api.example',
    model: 'gpt',
    maxTokens: 8192,
  })

  return (await import('./translation.post')).default as unknown as (event: {
    context: { params: { platform: string, id: string } }
    node: { req: { socket: { remoteAddress: string } } }
  }) => Promise<unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/auction/:platform/:id/translation', () => {
  it('accepts the LLM result as-is and does not retry or split mixed-language structured text', async () => {
    const { callTranslationLlm } = await import('~/server/utils/extract/text-llm')
    const { completeAuctionTranslation, writeContentTranslation } = await import('~/server/utils/content-translation')
    const payload = {
      title: 'Bebautes Einfamilienhaus',
      description: 'Größe: 5 Zimmer, 124 m²',
      documentSummary: null,
      extractionTexts: {
        biddingNotes: null,
        renovationNotes: null,
        floor: null,
        heating: null,
        insights: {
          defects: [],
          encumbrances: ['Utmätning (Pfändung) 2025-11-10'],
          construction: 'Holzkonstruktion mit Kriechkeller, Holzverkleidung (Träpanel)',
          locationCharacter: 'Gles bebyggelse, ländliche Umgebung',
          summary: null,
        },
        planningNotes: {
          monumentProtection: null,
          contamination: 'Värderingsobjektet är inte registrerat i Länsstyrelsens register.',
          developmentPlan: 'Värderingsobjektet är beläget inom planlagt område.',
          landConsolidation: null,
          developmentCharges: null,
          redevelopmentArea: null,
          conservationArea: null,
          landParcels: [{ label: 'Ljusdal Nor 1:5', use: 'Småhusenhet, bebyggd' }],
        },
      },
    }
    vi.mocked(callTranslationLlm).mockResolvedValue(payload)
    const handler = await loadHandler()

    await expect(handler({
      context: { params: { platform: 'se-kronofogden', id: '101738' } },
      node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    })).resolves.toMatchObject({ ...payload, translated: true })

    expect(callTranslationLlm).toHaveBeenCalledOnce()
    expect(writeContentTranslation).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      'de',
      payload.title,
      payload.description,
      payload.documentSummary,
      payload.extractionTexts,
    )
    expect(completeAuctionTranslation).toHaveBeenCalledWith(
      expect.anything(),
      'se-kronofogden',
      '101738',
      'de',
      CLAIM,
      payload,
    )
  })

  it('always serves the persistent auction cache after the first completed translation', async () => {
    const { callTranslationLlm } = await import('~/server/utils/extract/text-llm')
    const { readAuctionTranslation, claimAuctionTranslation } = await import('~/server/utils/content-translation')
    const handler = await loadHandler()
    const { auctionTranslationContentHash } = await import('./translation.post')
    const cached = {
      contentHash: auctionTranslationContentHash(auction()),
      status: 'completed' as const,
      errorMessage: null,
      failedConfig: null,
      claimStale: false,
      retryDue: true,
      title: 'Dauerhaft gespeicherter Titel',
      description: 'Dauerhaft gespeicherte Beschreibung',
      documentSummary: null,
      extractionTexts: null,
    }
    vi.mocked(readAuctionTranslation).mockResolvedValue(cached)

    await expect(handler({
      context: { params: { platform: 'se-kronofogden', id: '101738' } },
      node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    })).resolves.toEqual({
      title: cached.title,
      description: cached.description,
      documentSummary: null,
      extractionTexts: null,
      translated: true,
    })

    expect(claimAuctionTranslation).not.toHaveBeenCalled()
    expect(callTranslationLlm).not.toHaveBeenCalled()
  })

  it('regenerates a completed auction translation when the content hash changed', async () => {
    const { callTranslationLlm } = await import('~/server/utils/extract/text-llm')
    const {
      completeAuctionTranslation,
      readAuctionTranslation,
      claimAuctionTranslation,
    } = await import('~/server/utils/content-translation')
    const handler = await loadHandler()
    const { auctionTranslationContentHash } = await import('./translation.post')
    const expectedContentHash = auctionTranslationContentHash(auction())
    const payload = {
      title: 'Fresh title for changed content',
      description: 'Fresh description for changed content',
      documentSummary: null,
      extractionTexts: null,
    }
    vi.mocked(readAuctionTranslation).mockResolvedValue({
      contentHash: 'old-content-hash',
      status: 'completed',
      errorMessage: null,
      failedConfig: null,
      claimStale: false,
      retryDue: true,
      title: 'Old cached title',
      description: 'Old cached description',
      documentSummary: null,
      extractionTexts: null,
    })
    vi.mocked(callTranslationLlm).mockResolvedValue(payload)

    await expect(handler({
      context: { params: { platform: 'se-kronofogden', id: '101738' } },
      node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    })).resolves.toMatchObject({ ...payload, translated: true })

    expect(claimAuctionTranslation).toHaveBeenCalledOnce()
    expect(claimAuctionTranslation).toHaveBeenCalledWith(
      expect.anything(),
      'se-kronofogden',
      '101738',
      'de',
      expectedContentHash,
    )
    expect(callTranslationLlm).toHaveBeenCalledOnce()
    expect(completeAuctionTranslation).toHaveBeenCalledOnce()
    expect(completeAuctionTranslation).toHaveBeenCalledWith(
      expect.anything(),
      'se-kronofogden',
      '101738',
      'de',
      CLAIM,
      payload,
    )
  })

  it('serves the stored error instead of retrying while the retry window is closed', async () => {
    const { callTranslationLlm } = await import('~/server/utils/extract/text-llm')
    const { readAuctionTranslation, claimAuctionTranslation } = await import('~/server/utils/content-translation')
    const handler = await loadHandler()
    const { fingerprintConfig } = await import('./translation.post')
    vi.mocked(readAuctionTranslation).mockResolvedValue({
      contentHash: 'failed-content-hash',
      status: 'failed',
      errorMessage: 'Provider nicht erreichbar',
      // Same config that produced the failure — still inside the backoff window.
      failedConfig: fingerprintConfig({ provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt' }),
      claimStale: false,
      retryDue: false,
      title: null,
      description: null,
      documentSummary: null,
      extractionTexts: null,
    })

    await expect(handler({
      context: { params: { platform: 'se-kronofogden', id: '101738' } },
      node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    })).rejects.toMatchObject({
      statusCode: 502,
      data: { detail: 'Provider nicht erreichbar' },
    })

    expect(claimAuctionTranslation).not.toHaveBeenCalled()
    expect(callTranslationLlm).not.toHaveBeenCalled()
  })

  it('still honors the backoff for a legacy failed row with no recorded config (failedConfig: null)', async () => {
    const { callTranslationLlm } = await import('~/server/utils/extract/text-llm')
    const { readAuctionTranslation, claimAuctionTranslation } = await import('~/server/utils/content-translation')
    const handler = await loadHandler()
    vi.mocked(readAuctionTranslation).mockResolvedValue({
      contentHash: 'failed-content-hash',
      status: 'failed',
      errorMessage: 'Provider nicht erreichbar',
      // Row written before failed_config existed — must not be treated as
      // "config changed" (that would bypass the backoff for every
      // pre-existing failure on the first request after this ships).
      failedConfig: null,
      claimStale: false,
      retryDue: false,
      title: null,
      description: null,
      documentSummary: null,
      extractionTexts: null,
    })

    await expect(handler({
      context: { params: { platform: 'se-kronofogden', id: '101738' } },
      node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    })).rejects.toMatchObject({
      statusCode: 502,
      data: { detail: 'Provider nicht erreichbar' },
    })

    expect(claimAuctionTranslation).not.toHaveBeenCalled()
    expect(callTranslationLlm).not.toHaveBeenCalled()
  })

  it('retries immediately when the LLM config changed since the failure, even though the retry window is still closed', async () => {
    const { callTranslationLlm } = await import('~/server/utils/extract/text-llm')
    const { readAuctionTranslation, claimAuctionTranslation } = await import('~/server/utils/content-translation')
    const { resolveLlmConfig } = await import('~/server/utils/extract/llm')
    const handler = await loadHandler()
    const { fingerprintConfig } = await import('./translation.post')
    vi.mocked(readAuctionTranslation).mockResolvedValue({
      contentHash: 'failed-content-hash',
      status: 'failed',
      errorMessage: 'Rate limit exceeded',
      // Fingerprint of the OLD model — the assignment was switched in
      // /settings since this failure was recorded.
      failedConfig: fingerprintConfig({ provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt' }),
      claimStale: false,
      retryDue: false,
      title: null,
      description: null,
      documentSummary: null,
      extractionTexts: null,
    })
    vi.mocked(resolveLlmConfig).mockReturnValue({
      provider: 'openai-compatible',
      baseUrl: 'https://api.example',
      model: 'gpt-4o-mini',
      maxTokens: 8192,
    })
    vi.mocked(callTranslationLlm).mockResolvedValue({
      title: 'Translated with the new model',
      description: null,
      documentSummary: null,
      extractionTexts: null,
    })

    await expect(handler({
      context: { params: { platform: 'se-kronofogden', id: '101738' } },
      node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    })).resolves.toMatchObject({ title: 'Translated with the new model', translated: true })

    expect(claimAuctionTranslation).toHaveBeenCalledOnce()
    expect(callTranslationLlm).toHaveBeenCalledOnce()
  })

  it('records the resolved config fingerprint when a translation attempt fails', async () => {
    const { callTranslationLlm } = await import('~/server/utils/extract/text-llm')
    const { failAuctionTranslation } = await import('~/server/utils/content-translation')
    const handler = await loadHandler()
    const { fingerprintConfig } = await import('./translation.post')
    vi.mocked(callTranslationLlm).mockResolvedValue(null)

    await expect(handler({
      context: { params: { platform: 'se-kronofogden', id: '101738' } },
      node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    })).rejects.toMatchObject({ statusCode: 502 })

    expect(failAuctionTranslation).toHaveBeenCalledWith(
      expect.anything(),
      'se-kronofogden',
      '101738',
      'de',
      CLAIM,
      expect.any(String),
      fingerprintConfig({ provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt' }),
    )
  })

  it('retries a failed attempt once its retry window opened — a provider outage must not lock the auction out', async () => {
    const { callTranslationLlm } = await import('~/server/utils/extract/text-llm')
    const { readAuctionTranslation, claimAuctionTranslation } = await import('~/server/utils/content-translation')
    const handler = await loadHandler()
    vi.mocked(readAuctionTranslation).mockResolvedValue({
      contentHash: 'failed-content-hash',
      status: 'failed',
      errorMessage: 'Provider nicht erreichbar',
      failedConfig: null,
      claimStale: true,
      retryDue: true,
      title: null,
      description: null,
      documentSummary: null,
      extractionTexts: null,
    })
    vi.mocked(callTranslationLlm).mockResolvedValue({
      title: 'Retried title',
      description: 'Retried description',
      documentSummary: null,
      extractionTexts: null,
    })

    await expect(handler({
      context: { params: { platform: 'se-kronofogden', id: '101738' } },
      node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    })).resolves.toMatchObject({ title: 'Retried title', translated: true })

    expect(claimAuctionTranslation).toHaveBeenCalledOnce()
    expect(callTranslationLlm).toHaveBeenCalledOnce()
  })

  it('takes over an abandoned pending claim whose lease expired', async () => {
    const { callTranslationLlm } = await import('~/server/utils/extract/text-llm')
    const { readAuctionTranslation, claimAuctionTranslation } = await import('~/server/utils/content-translation')
    const handler = await loadHandler()
    vi.mocked(readAuctionTranslation).mockResolvedValue({
      contentHash: 'stale-content-hash',
      status: 'pending',
      errorMessage: null,
      failedConfig: null,
      claimStale: true,
      retryDue: false,
      title: null,
      description: null,
      documentSummary: null,
      extractionTexts: null,
    })
    vi.mocked(callTranslationLlm).mockResolvedValue({
      title: 'Recovered title',
      description: 'Recovered description',
      documentSummary: null,
      extractionTexts: null,
    })

    await expect(handler({
      context: { params: { platform: 'se-kronofogden', id: '101738' } },
      node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    })).resolves.toMatchObject({ title: 'Recovered title', translated: true })

    expect(claimAuctionTranslation).toHaveBeenCalledOnce()
  })

  it('waits for the in-memory generation when the durable row is pending in this process', async () => {
    const { callTranslationLlm } = await import('~/server/utils/extract/text-llm')
    const { readAuctionTranslation, claimAuctionTranslation } = await import('~/server/utils/content-translation')
    const handler = await loadHandler()
    const payload = {
      title: 'Shared translated title',
      description: 'Shared translated description',
      documentSummary: null,
      extractionTexts: null,
    }
    let resolveTranslation!: (value: typeof payload) => void
    vi.mocked(callTranslationLlm).mockImplementation(() => new Promise((resolve) => {
      resolveTranslation = resolve
    }))
    vi.mocked(readAuctionTranslation)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        contentHash: 'pending-content-hash',
        status: 'pending',
        errorMessage: null,
        failedConfig: null,
        claimStale: false,
        retryDue: false,
        title: null,
        description: null,
        documentSummary: null,
        extractionTexts: null,
      })

    const first = handler({
      context: { params: { platform: 'se-kronofogden', id: '101738' } },
      node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    })
    await vi.waitFor(() => expect(callTranslationLlm).toHaveBeenCalledOnce())

    const second = handler({
      context: { params: { platform: 'se-kronofogden', id: '101738' } },
      node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    })
    resolveTranslation(payload)

    await expect(first).resolves.toMatchObject({ ...payload, translated: true })
    await expect(second).resolves.toMatchObject({ ...payload, translated: true })
    expect(claimAuctionTranslation).toHaveBeenCalledOnce()
  })

  it('does not call the provider when another request won the atomic claim', async () => {
    const { callTranslationLlm } = await import('~/server/utils/extract/text-llm')
    const { claimAuctionTranslation } = await import('~/server/utils/content-translation')
    const handler = await loadHandler()
    vi.mocked(claimAuctionTranslation).mockResolvedValue(null)

    await expect(handler({
      context: { params: { platform: 'se-kronofogden', id: '101738' } },
      node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    })).rejects.toMatchObject({ statusCode: 409 })

    expect(callTranslationLlm).not.toHaveBeenCalled()
  })

  it('falls back to the next configured model when the primary is unavailable', async () => {
    const { callTranslationLlm } = await import('~/server/utils/extract/text-llm')
    const { getLlmProviderOverrideChain } = await import('~/server/utils/app-settings')
    const { resolveLlmConfig, LlmProviderError } = await import('~/server/utils/extract/llm')
    const { completeAuctionTranslation, failAuctionTranslation } = await import('~/server/utils/content-translation')
    const handler = await loadHandler()

    vi.mocked(getLlmProviderOverrideChain).mockImplementation(async (_db, scope) => {
      if (scope !== 'translation') return []
      return [
        { provider: 'gemini-native', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash-lite', executionMode: 'sync', apiKey: 'key' },
        { provider: 'gemini-native', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3.1-flash-lite', executionMode: 'sync', apiKey: 'key' },
      ]
    })
    vi.mocked(resolveLlmConfig).mockImplementation((source) => (source
      ? { provider: source.provider as 'gemini-native', baseUrl: source.baseUrl!, model: source.model!, maxTokens: 8192 }
      : null))
    const payload = {
      title: 'Bebautes Einfamilienhaus',
      description: 'Größe: 5 Zimmer, 124 m²',
      documentSummary: null,
      extractionTexts: null,
    }
    vi.mocked(callTranslationLlm).mockImplementation(async (...args) => {
      const config = args[6] as { model: string }
      if (config.model === 'gemini-2.5-flash-lite') {
        throw new LlmProviderError('gemini-native', '[POST] "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent": 404 Not Found')
      }
      return payload
    })

    await expect(handler({
      context: { params: { platform: 'se-kronofogden', id: '101738' } },
      node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    })).resolves.toMatchObject({ ...payload, translated: true })

    expect(callTranslationLlm).toHaveBeenCalledTimes(2)
    expect((vi.mocked(callTranslationLlm).mock.calls[0]![6] as { model: string }).model).toBe('gemini-2.5-flash-lite')
    expect((vi.mocked(callTranslationLlm).mock.calls[1]![6] as { model: string }).model).toBe('gemini-3.1-flash-lite')
    expect(failAuctionTranslation).not.toHaveBeenCalled()
    expect(completeAuctionTranslation).toHaveBeenCalledWith(
      expect.anything(), 'se-kronofogden', '101738', 'de', CLAIM, payload,
    )
  })

  it('does not fall back to the next model for a non-availability error', async () => {
    const { callTranslationLlm } = await import('~/server/utils/extract/text-llm')
    const { getLlmProviderOverrideChain } = await import('~/server/utils/app-settings')
    const { resolveLlmConfig } = await import('~/server/utils/extract/llm')
    const handler = await loadHandler()

    vi.mocked(getLlmProviderOverrideChain).mockImplementation(async (_db, scope) => {
      if (scope !== 'translation') return []
      return [
        { provider: 'gemini-native', baseUrl: 'https://generativelanguage.googleapis.com', model: 'primary', executionMode: 'sync', apiKey: 'key' },
        { provider: 'gemini-native', baseUrl: 'https://generativelanguage.googleapis.com', model: 'fallback', executionMode: 'sync', apiKey: 'key' },
      ]
    })
    vi.mocked(resolveLlmConfig).mockImplementation((source) => (source
      ? { provider: source.provider as 'gemini-native', baseUrl: source.baseUrl!, model: source.model!, maxTokens: 8192 }
      : null))
    vi.mocked(callTranslationLlm).mockRejectedValue(new Error('boom'))

    await expect(handler({
      context: { params: { platform: 'se-kronofogden', id: '101738' } },
      node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    })).rejects.toMatchObject({ statusCode: 502 })

    expect(callTranslationLlm).toHaveBeenCalledTimes(1)
  })
})
