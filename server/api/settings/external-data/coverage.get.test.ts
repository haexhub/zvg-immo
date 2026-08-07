import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn(() => null) }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('GET /api/settings/external-data/coverage', () => {
  it('returns an empty source list with no DB configured', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)

    const handler = (await import('./coverage.get')).default as unknown as () => Promise<{ sources: unknown[] }>
    const { sources } = await handler()

    expect(sources).toEqual([])
  })

  it('aggregates per-country rows into per-source totals, dropping countries with no geocoded auctions', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)

    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({
      query: async () => ({
        rows: [
          {
            country: 'de',
            geocoded_total: '100',
            cams_air_quality: '80',
            open_meteo_climate_normals: '60',
            eea_environmental_noise_directive: '40',
            eu_flood_risk_areas: '20',
            copernicus_effis: '10',
            fr_dvf_geolocated: '0',
          },
          {
            country: 'fr',
            geocoded_total: '50',
            cams_air_quality: '10',
            open_meteo_climate_normals: '5',
            eea_environmental_noise_directive: '5',
            eu_flood_risk_areas: '0',
            copernicus_effis: '0',
            fr_dvf_geolocated: '45',
          },
          {
            // No geocoded auctions at all — must not show up in any byCountry list.
            country: 'is',
            geocoded_total: '0',
            cams_air_quality: '0',
            open_meteo_climate_normals: '0',
            eea_environmental_noise_directive: '0',
            eu_flood_risk_areas: '0',
            copernicus_effis: '0',
            fr_dvf_geolocated: '0',
          },
        ],
      }),
    } as never)

    const handler = (await import('./coverage.get')).default as unknown as () => Promise<{
      sources: Array<{ id: string; total: number; covered: number; byCountry: Array<{ country: string; total: number; covered: number }> }>
    }>
    const { sources } = await handler()

    expect(sources.map((source) => source.id).sort()).toEqual([
      'cams-air-quality',
      'copernicus-effis',
      'eea-environmental-noise-directive',
      'eu-flood-risk-areas',
      'fr-dvf-geolocated',
      'open-meteo-climate-normals',
    ])

    const climate = sources.find((source) => source.id === 'open-meteo-climate-normals')!
    expect(climate.total).toBe(150)
    expect(climate.covered).toBe(65)
    expect(climate.byCountry).toEqual([
      { country: 'de', total: 100, covered: 60 },
      { country: 'fr', total: 50, covered: 5 },
    ])

    const dvf = sources.find((source) => source.id === 'fr-dvf-geolocated')!
    expect(dvf.byCountry).toEqual([
      { country: 'de', total: 100, covered: 0 },
      { country: 'fr', total: 50, covered: 45 },
    ])
  })
})
