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
  readContentTranslation: vi.fn(),
  writeContentTranslation: vi.fn(),
}))

vi.mock('~/server/utils/app-settings', () => ({
  getLlmMaxTokens: vi.fn(),
  getLlmProviderOverride: vi.fn(),
}))

vi.mock('~/server/utils/extract/llm', () => ({
  resolveLlmConfig: vi.fn(),
}))

vi.mock('~/server/utils/extract/text-llm', () => ({
  callTranslationLlm: vi.fn(),
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
  const { readContentTranslation, writeContentTranslation } = await import('~/server/utils/content-translation')
  const { getLlmMaxTokens, getLlmProviderOverride } = await import('~/server/utils/app-settings')
  const { resolveLlmConfig } = await import('~/server/utils/extract/llm')

  vi.mocked(readAuctionSnapshot).mockResolvedValue({ 'se-kronofogden:101738': auction() })
  vi.mocked(getPool).mockReturnValue({} as Pool)
  vi.mocked(readContentTranslation).mockResolvedValue(null)
  vi.mocked(writeContentTranslation).mockResolvedValue(undefined)
  vi.mocked(getLlmProviderOverride).mockResolvedValue(null)
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
    const { writeContentTranslation } = await import('~/server/utils/content-translation')
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
  })
})
