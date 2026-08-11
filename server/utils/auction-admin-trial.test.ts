import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from './db'
import { readAuctionRecord } from './auction-record'
import { writeAuctionDetails } from './auction-details'
import { reprocessAuction } from '../tasks/reprocess'
import { resolveLlmConfigForProfile } from './extract/llm-task-config'
import { getLlmKillSwitch } from './app-settings'
import { recordTaskRunError } from './task-run-errors'
import { recordLlmUsage } from './llm-usage'
import { validateAdminTrialReprocess, runAdminTrialReprocess } from './auction-admin-trial'
import type { Auction, AuctionExtraction } from '~/types/auction'

vi.mock('./db', () => ({ getPool: vi.fn() }))
vi.mock('./auction-record', () => ({ readAuctionRecord: vi.fn() }))
vi.mock('./auction-details', () => ({ writeAuctionDetails: vi.fn() }))
vi.mock('../tasks/reprocess', () => ({ reprocessAuction: vi.fn() }))
vi.mock('./extract/llm-task-config', () => ({ resolveLlmConfigForProfile: vi.fn() }))
vi.mock('./app-settings', () => ({ getLlmKillSwitch: vi.fn() }))
vi.mock('./task-run-errors', () => ({ recordTaskRunError: vi.fn() }))
vi.mock('./llm-usage', () => ({ recordLlmUsage: vi.fn() }))

const CONFIG = { provider: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'deepseek/deepseek-v4-pro', profileId: 'profile-1' }

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    platform: 'zvg-portal', externalId: '7265', country: 'de', region: 'bayern',
    authority: 'AG München', caseNumber: '12 K 3/26', title: 'Haus', address: null,
    auctionDateIso: null, auctionDateText: null, cancelled: false, lat: null, lng: null,
    description: null, extraction: null,
    ...overrides,
  } as Auction
}

function extraction(overrides: Partial<AuctionExtraction> = {}): AuctionExtraction {
  return { propertyType: 'einfamilienhaus', source: 'llm', confidence: 'high', at: '2026-08-08T10:00:00.000Z', ...overrides } as AuctionExtraction
}

beforeEach(() => {
  vi.mocked(getPool).mockReturnValue({} as never)
  vi.mocked(getLlmKillSwitch).mockResolvedValue(false)
  vi.mocked(resolveLlmConfigForProfile).mockResolvedValue(CONFIG)
  vi.mocked(readAuctionRecord).mockResolvedValue({
    auction: auction(), detailsId: 7, detailsVersion: 3, artifactVersionId: 11,
  })
  vi.mocked(reprocessAuction).mockResolvedValue({
    entry: extraction(), llmCalled: true, llmFailures: 0, artifactVersionId: 11,
    auction: auction(), llmConfigUsed: CONFIG, llmDurationMs: 1234,
    llmUsage: { inputTokens: 500, outputTokens: 150 },
  })
  vi.mocked(writeAuctionDetails).mockResolvedValue({ version: 4, changed: true })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('validateAdminTrialReprocess', () => {
  it('rejects an unknown profile', async () => {
    vi.mocked(resolveLlmConfigForProfile).mockResolvedValue(null)

    await expect(validateAdminTrialReprocess('zvg-portal', '7265', 'nope')).resolves.toEqual({ ok: false, reason: 'unknown_profile' })
  })

  it('rejects an unknown identity', async () => {
    vi.mocked(readAuctionRecord).mockResolvedValue(null)

    await expect(validateAdminTrialReprocess('zvg-portal', 'missing', 'profile-1')).resolves.toEqual({ ok: false, reason: 'not_found' })
  })

  it('accepts a known profile and identity', async () => {
    await expect(validateAdminTrialReprocess('zvg-portal', '7265', 'profile-1')).resolves.toEqual({ ok: true })
  })

  it('rejects when the admin kill switch is on, without resolving the profile', async () => {
    vi.mocked(getLlmKillSwitch).mockResolvedValue(true)

    await expect(validateAdminTrialReprocess('zvg-portal', '7265', 'profile-1')).resolves.toEqual({ ok: false, reason: 'llm_disabled' })
    expect(resolveLlmConfigForProfile).not.toHaveBeenCalled()
  })
})

describe('runAdminTrialReprocess', () => {
  it('writes a trial version with provenance, without touching llm_failures or the search projection', async () => {
    await runAdminTrialReprocess('zvg-portal', '7265', 'profile-1')

    expect(writeAuctionDetails).toHaveBeenCalledTimes(1)
    const [, entryArg, optionsArg] = vi.mocked(writeAuctionDetails).mock.calls[0]!
    expect(entryArg).toMatchObject({ propertyType: 'einfamilienhaus' })
    expect(optionsArg).toEqual({
      artifactVersionId: 11,
      llmProvider: 'openrouter',
      llmModel: 'deepseek/deepseek-v4-pro',
      llmProfileId: 'profile-1',
      runTrigger: 'manual',
      llmDurationMs: 1234,
      trial: true,
    })
    expect(recordLlmUsage).toHaveBeenCalledWith({
      task: 'extraction',
      executionMode: 'sync',
      source: 'admin-trial',
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-pro',
      profileId: 'profile-1',
      platform: 'zvg-portal',
      externalId: '7265',
      usage: { inputTokens: 500, outputTokens: 150 },
    })
    expect(recordTaskRunError).not.toHaveBeenCalled()
  })

  it('records an error and skips the write when the profile is unknown', async () => {
    vi.mocked(resolveLlmConfigForProfile).mockResolvedValue(null)

    await runAdminTrialReprocess('zvg-portal', '7265', 'nope')

    expect(writeAuctionDetails).not.toHaveBeenCalled()
    expect(recordTaskRunError).toHaveBeenCalledWith('reprocess', expect.objectContaining({
      platform: 'zvg-portal', externalId: '7265', category: 'admin_trial',
    }))
  })

  it('records an error when no archived capture exists', async () => {
    vi.mocked(reprocessAuction).mockResolvedValue(null)

    await runAdminTrialReprocess('zvg-portal', '7265', 'profile-1')

    expect(writeAuctionDetails).not.toHaveBeenCalled()
    expect(recordTaskRunError).toHaveBeenCalledWith('reprocess', expect.objectContaining({ category: 'admin_trial' }))
  })

  it('records the thrown message when reprocessAuction rejects', async () => {
    vi.mocked(reprocessAuction).mockRejectedValue(new Error('openrouter: [POST] "https://openrouter.ai/api/v1/chat/completions": 404 Not Found'))

    await runAdminTrialReprocess('zvg-portal', '7265', 'profile-1')

    expect(recordTaskRunError).toHaveBeenCalledWith('reprocess', {
      platform: 'zvg-portal', externalId: '7265', category: 'admin_trial',
      message: 'openrouter: [POST] "https://openrouter.ai/api/v1/chat/completions": 404 Not Found',
    })
  })
})
