import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/auction-details-read', () => ({ readAuctionDetailsAtVersion: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('GET /api/settings/auction/[platform]/[id]/versions/[version]', () => {
  it('rejects a non-numeric version', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => ({ platform: 'zvg-portal', id: '7265', version: 'abc' })[name])
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))

    const handler = (await import('./[version].get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s when the version does not exist', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => ({ platform: 'zvg-portal', id: '7265', version: '2' })[name])
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { readAuctionDetailsAtVersion } = await import('~/server/utils/auction-details-read')
    vi.mocked(readAuctionDetailsAtVersion).mockResolvedValue(null)

    const handler = (await import('./[version].get')).default as (event: unknown) => Promise<unknown>

    await expect(handler({})).rejects.toMatchObject({ statusCode: 404 })
  })

  it('projects the raw row onto camelCase field names', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => ({ platform: 'zvg-portal', id: '7265', version: '2' })[name])
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    const { readAuctionDetailsAtVersion } = await import('~/server/utils/auction-details-read')
    vi.mocked(readAuctionDetailsAtVersion).mockResolvedValue({
      id: 5, platform: 'zvg-portal', external_id: '7265', version: 2, artifact_version_id: 11,
      created_at: '2026-08-08T10:00:00.000Z', extracted_at: '2026-08-08T10:00:00.000Z',
      address: 'Hauptstr. 1', description: 'Beschreibung', property_type: 'einfamilienhaus',
      land_area_sqm: 500, living_area_sqm: 150, rooms: 4, bedrooms: null, bathrooms: null,
      floor: null, bathroom_has_tub: null, bathroom_has_shower: null, heating: null, units: 1,
      year_built: null, last_renovation_year: null, market_value: null, currency: null,
      market_value_eur: 250000, condition: null, features: ['garten'], insights: null,
      planning_notes: null, renovation_notes: null, starting_bid: null, current_bid: null,
      source_security_deposit: null, security_deposit: null, bidding_notes: null, photo_count: 0,
      thumbnail_url: null, extraction_source: 'llm', extraction_confidence: 'high',
      llm_analyzed_at: null, document_summary: null, extraction_texts: null,
      source_living_area_sqm: null, source_land_area_sqm: null, source_rooms: null,
      market_value_text: null, is_latest: false, is_trial: true, llm_provider: 'openrouter',
      llm_model: 'deepseek/deepseek-v4-pro', llm_profile_id: 'profile-1', run_trigger: 'manual',
      llm_duration_ms: 4200,
    })

    const handler = (await import('./[version].get')).default as (event: unknown) => Promise<{ address: string; propertyType: string; livingAreaSqm: number }>

    const result = await handler({})
    expect(result).toMatchObject({ address: 'Hauptstr. 1', propertyType: 'einfamilienhaus', livingAreaSqm: 150 })
  })
})
