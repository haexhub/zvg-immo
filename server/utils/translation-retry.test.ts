import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'

vi.mock('~/server/utils/auction-record', () => ({ readAuctionRecord: vi.fn() }))
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

function auction(externalId: string, overrides: Record<string, unknown> = {}) {
  return {
    platform: 'se-kronofogden',
    country: 'se',
    externalId,
    title: 'Haus',
    address: null,
    description: null,
    extraction: undefined,
    ...overrides,
  } as never
}

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('retryAuctionTranslation', () => {
  it('returns not_found when the auction has no versioned details', async () => {
    const { readAuctionRecord } = await import('~/server/utils/auction-record')
    vi.mocked(readAuctionRecord).mockResolvedValue({ auction: auction('1'), detailsId: null, detailsVersion: null, artifactVersionId: null })
    const { retryAuctionTranslation } = await import('./translation-retry')

    await expect(retryAuctionTranslation({} as Pool, 'se-kronofogden', '1', 'de')).resolves.toBe('not_found')
  })

  it('returns already_running when the claim is held', async () => {
    const { readAuctionRecord } = await import('~/server/utils/auction-record')
    const { claimAuctionTranslation } = await import('~/server/utils/content-translation')
    vi.mocked(readAuctionRecord).mockResolvedValue({ auction: auction('1'), detailsId: 1, detailsVersion: 1, artifactVersionId: null })
    vi.mocked(claimAuctionTranslation).mockResolvedValue(null)
    const { retryAuctionTranslation } = await import('./translation-retry')

    await expect(retryAuctionTranslation({} as Pool, 'se-kronofogden', '1', 'de')).resolves.toBe('already_running')
  })

  it('claims and returns started without waiting for the background translation to finish', async () => {
    const { readAuctionRecord } = await import('~/server/utils/auction-record')
    const { claimAuctionTranslation, readContentTranslation } = await import('~/server/utils/content-translation')
    vi.mocked(readAuctionRecord).mockResolvedValue({ auction: auction('1'), detailsId: 1, detailsVersion: 1, artifactVersionId: null })
    vi.mocked(claimAuctionTranslation).mockResolvedValue(CLAIM)
    // Never resolves — proves retryAuctionTranslation doesn't await it.
    vi.mocked(readContentTranslation).mockReturnValue(new Promise(() => {}))
    const { retryAuctionTranslation } = await import('./translation-retry')

    await expect(retryAuctionTranslation({} as Pool, 'se-kronofogden', '1', 'de')).resolves.toBe('started')
  })
})

describe('retryTranslationsBulk', () => {
  it('processes every item best-effort, one failure does not block the rest', async () => {
    const { readAuctionRecord } = await import('~/server/utils/auction-record')
    const { claimAuctionTranslation, completeAuctionTranslation, readContentTranslation } = await import('~/server/utils/content-translation')
    vi.mocked(readAuctionRecord).mockImplementation(async (_platform, externalId) =>
      externalId === 'missing'
        ? null
        : { auction: auction(externalId), detailsId: 1, detailsVersion: 1, artifactVersionId: null },
    )
    vi.mocked(claimAuctionTranslation).mockResolvedValue(CLAIM)
    vi.mocked(readContentTranslation).mockResolvedValue({
      title: 'Retried', address: null, description: null, documentSummary: null, extractionTexts: null,
    })
    const { retryTranslationsBulk } = await import('./translation-retry')

    await retryTranslationsBulk({} as Pool, [
      { platform: 'se-kronofogden', externalId: '1', lang: 'de' },
      { platform: 'se-kronofogden', externalId: 'missing', lang: 'de' },
      { platform: 'se-kronofogden', externalId: '2', lang: 'en' },
    ])

    expect(completeAuctionTranslation).toHaveBeenCalledTimes(2)
    expect(completeAuctionTranslation).toHaveBeenCalledWith(
      expect.anything(), 'se-kronofogden', '1', 1, 'de', CLAIM, expect.objectContaining({ title: 'Retried' }),
    )
    expect(completeAuctionTranslation).toHaveBeenCalledWith(
      expect.anything(), 'se-kronofogden', '2', 1, 'en', CLAIM, expect.objectContaining({ title: 'Retried' }),
    )
  })
})
