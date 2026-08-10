import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/auction-record', () => ({ readAuctionRecords: vi.fn() }))
vi.mock('~/server/utils/db', () => ({ getPool: vi.fn() }))

const COMPLETE_LLM_FIELDS = {
  condition: null, features: [], bedrooms: null, bathrooms: null, floor: null,
  bathroomHasTub: null, bathroomHasShower: null, heating: null, yearBuilt: null,
  lastRenovationYear: null, renovationNotes: null, insights: null, planningNotes: null,
  documentSummary: null, marketValueEur: null,
}

function record(externalId: string, opts: { extraction?: Record<string, unknown>; llmFailures?: number } = {}) {
  return {
    detailsId: 1,
    detailsVersion: 1,
    artifactVersionId: null,
    auction: {
      platform: 'zvg-portal',
      externalId,
      country: 'de',
      region: 'Berlin',
      caseNumber: `1 K ${externalId}/26`,
      title: `Haus ${externalId}`,
      auctionDateIso: null,
      extraction: opts.extraction,
      processing: { llmFailures: opts.llmFailures ?? 0 },
    },
  } as never
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/llm-status/[country]', () => {
  it('rejects an invalid bucket', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', () => 'de')
    vi.stubGlobal('getQuery', () => ({ bucket: 'nonsense' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./[country].get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('filters by bucket, paginates and only looks up error messages for the error bucket', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', () => 'de')
    vi.stubGlobal('getQuery', () => ({ bucket: 'open', limit: '1', offset: '0' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { getPool } = await import('~/server/utils/db')
    const query = vi.fn()
    vi.mocked(getPool).mockReturnValue({ query } as never)
    vi.mocked(readAuctionRecords).mockResolvedValue([
      record('1'), // open
      record('2'), // open
      record('3', { extraction: { source: 'llm', confidence: 'high', ...COMPLETE_LLM_FIELDS } }), // done, filtered out
    ])

    const handler = (await import('./[country].get')).default as (event: unknown) => Promise<unknown>
    const result = await handler({}) as { items: unknown[]; total: number }

    expect(result.total).toBe(2)
    expect(result.items).toHaveLength(1)
    expect(query).not.toHaveBeenCalled()
    expect(readAuctionRecords).toHaveBeenCalledWith('de', { includePhotos: false })
  })

  it('looks up the last error message for the error bucket, scoped to the current page', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', () => 'de')
    vi.stubGlobal('getQuery', () => ({ bucket: 'error' }))
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    const { getPool } = await import('~/server/utils/db')
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ platform: 'zvg-portal', external_id: '1', message: 'quota exceeded' }] }))
    vi.mocked(getPool).mockReturnValue({ query } as never)
    vi.mocked(readAuctionRecords).mockResolvedValue([record('1', { llmFailures: 3 })])

    const handler = (await import('./[country].get')).default as (event: unknown) => Promise<unknown>
    const result = await handler({}) as { items: { lastErrorMessage: string | null }[] }

    expect(result.items[0]?.lastErrorMessage).toBe('quota exceeded')
    expect(query.mock.calls[0]?.[0]).toContain("task = 'reprocess'")
  })
})
