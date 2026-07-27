import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/external-data/eu-flood-risk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/external-data/eu-flood-risk')>()
  return {
    ...actual,
    importEuFloodRiskGeoJsonCache: vi.fn(),
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('runImportEuFloodRiskCache', () => {
  it('imports the EU flood cache with official defaults', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { importEuFloodRiskGeoJsonCache, EU_FLOOD_RISK_POLYGON_LAYER_URL } = await import('~/server/utils/external-data/eu-flood-risk')
    vi.mocked(importEuFloodRiskGeoJsonCache).mockResolvedValue({
      cachePath: '/tmp/eu-flood-risk.geojson',
      serviceUrl: EU_FLOOD_RISK_POLYGON_LAYER_URL,
      sourceVersion: 'eea-floods-ref-v03-r00-2025-08-05',
      generatedAt: '2026-07-27T00:00:00.000Z',
      fetched: 2,
      normalized: 2,
      pages: 1,
    })

    const { runImportEuFloodRiskCache } = await import('./import-eu-flood-risk-cache')
    const summary = await runImportEuFloodRiskCache({
      cachePath: '/tmp/eu-flood-risk.geojson',
      generatedAt: '2026-07-27T00:00:00.000Z',
      countryCodes: ['de', 'fr'],
    })

    expect(summary.normalized).toBe(2)
    expect(importEuFloodRiskGeoJsonCache).toHaveBeenCalledWith({
      cachePath: '/tmp/eu-flood-risk.geojson',
      serviceUrl: EU_FLOOD_RISK_POLYGON_LAYER_URL,
      sourceVersion: 'eea-floods-ref-v03-r00-2025-08-05',
      generatedAt: '2026-07-27T00:00:00.000Z',
      pageSize: undefined,
      maxPages: undefined,
      countryCodes: ['de', 'fr'],
    })
  })
})
