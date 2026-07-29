import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn(() => null) }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('GET /api/settings/external-data/sources', () => {
  it('lists every configurable source with env-resolved effective values, no DB configured', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('useRuntimeConfig', () => ({
      externalData: { osmContextEndpoint: 'https://overpass-api.de/api/interpreter' },
    }))

    const handler = (await import('./sources.get')).default as unknown as () => Promise<{
      sources: Array<{ id: string; isConfigured: boolean; fields: Array<{ key: string; effectiveValue: unknown }> }>
    }>
    const { sources } = await handler()

    expect(sources.map((source) => source.id).sort()).toEqual([
      'cams-air-quality',
      'copernicus-effis',
      'eea-environmental-noise-directive',
      'eu-flood-risk-areas',
      'fr-dvf-geolocated',
      'openstreetmap-overpass',
    ])
    // Public API with a working default, so it is usable with no config at all.
    expect(sources.find((source) => source.id === 'cams-air-quality')!.isConfigured).toBe(true)
    const osm = sources.find((source) => source.id === 'openstreetmap-overpass')!
    expect(osm.isConfigured).toBe(true)
    expect(osm.fields.find((field) => field.key === 'endpoint')?.effectiveValue).toBe('https://overpass-api.de/api/interpreter')
    const dvf = sources.find((source) => source.id === 'fr-dvf-geolocated')!
    expect(dvf.isConfigured).toBe(false)
  })

  it('a DB-stored override shows up as the effective value', async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('useRuntimeConfig', () => ({ externalData: {} }))

    const { getPool } = await import('~/server/utils/db')
    vi.mocked(getPool).mockReturnValue({
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('SELECT key, value FROM app_settings WHERE key = ANY')) {
          const [keys] = params as [string[]]
          return {
            rows: keys
              .filter((key) => key === 'external_data_config_openstreetmap-overpass')
              .map((key) => ({ key, value: { endpoint: 'https://mirror.example/api/interpreter' } })),
          }
        }
        return { rows: [] }
      },
    } as never)

    const handler = (await import('./sources.get')).default as unknown as () => Promise<{
      sources: Array<{ id: string; fields: Array<{ key: string; storedValue: unknown; effectiveValue: unknown }> }>
    }>
    const { sources } = await handler()
    const osm = sources.find((source) => source.id === 'openstreetmap-overpass')!
    expect(osm.fields.find((field) => field.key === 'endpoint')).toMatchObject({
      storedValue: 'https://mirror.example/api/interpreter',
      effectiveValue: 'https://mirror.example/api/interpreter',
    })
  })
})
