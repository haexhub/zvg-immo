import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/auction-record', () => ({ readAuctionRecords: vi.fn() }))

const COMPLETE_LLM_FIELDS = {
  condition: null, features: [], bedrooms: null, bathrooms: null, floor: null,
  bathroomHasTub: null, bathroomHasShower: null, heating: null, yearBuilt: null,
  lastRenovationYear: null, renovationNotes: null, insights: null, planningNotes: null,
  documentSummary: null, marketValueEur: null,
}

function record(country: string, extraction?: Record<string, unknown>) {
  return { detailsId: 1, detailsVersion: 1, artifactVersionId: null, auction: { country, extraction, processing: { llmFailures: 0 } } } as never
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('/api/settings/llm-status', () => {
  it('classifies every record and aggregates per country', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { readAuctionRecords } = await import('~/server/utils/auction-record')
    vi.mocked(readAuctionRecords).mockResolvedValue([
      record('de', undefined), // open (never extracted)
      record('de', { source: 'llm', confidence: 'high', ...COMPLETE_LLM_FIELDS }), // done
      record('se', undefined), // open
    ] as never)

    const handler = (await import('./llm-status.get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({
      de: { done: 1, open: 1, error: 0, pending: 0, total: 2 },
      se: { done: 0, open: 1, error: 0, pending: 0, total: 1 },
    })
    expect(readAuctionRecords).toHaveBeenCalledWith(undefined, { includePhotos: false })
  })
})
