import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import {
  configurableExternalDataSources,
  getAllStoredExternalDataSourceConfigs,
  getConfigurableExternalDataSource,
  getStoredExternalDataSourceConfig,
  resolveExternalDataSourceConfig,
  setStoredExternalDataSourceConfig,
} from './config'

/** Mirrors app-settings.test.ts's fake pool — same app_settings query shapes. */
function makeFakePool() {
  const rows = new Map<string, unknown>()
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT value FROM app_settings WHERE key =')) {
      const [key] = params as [string]
      return rows.has(key) ? { rows: [{ value: rows.get(key) }] } : { rows: [] }
    }
    if (sql.includes('SELECT key, value FROM app_settings WHERE key = ANY')) {
      const [keys] = params as [string[]]
      return { rows: keys.filter((k) => rows.has(k)).map((k) => ({ key: k, value: rows.get(k) })) }
    }
    if (sql.includes('INSERT INTO app_settings')) {
      const [key, value] = params as [string, string]
      rows.set(key, JSON.parse(value))
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  }
  return { query } as unknown as Pool
}

describe('configurableExternalDataSources', () => {
  it('lists exactly the sources with a real adapter', () => {
    const ids = configurableExternalDataSources().map((source) => source.id).sort()
    expect(ids).toEqual([
      'cams-air-quality',
      'copernicus-effis',
      'eea-environmental-noise-directive',
      'eu-flood-risk-areas',
      'eurostat-regional-tourism-nights',
      'fr-dvf-geolocated',
      'open-meteo-climate-normals',
    ])
  })

  it('excludes discovery-only registry entries (no configFields)', () => {
    expect(getConfigurableExternalDataSource('eurostat-house-price-index')).toBeUndefined()
  })
})

describe('resolveExternalDataSourceConfig', () => {
  const source = getConfigurableExternalDataSource('eea-environmental-noise-directive')!

  it('falls back to the field default when neither DB nor env is set', () => {
    const resolved = resolveExternalDataSourceConfig(source, {}, {})
    expect(resolved.values.serviceBaseUrl).toBe('')
    expect(resolved.values.timeoutMs).toBe(10_000)
    expect(resolved.isConfigured).toBe(false)
  })

  it('env runtimeConfig wins over the field default', () => {
    const resolved = resolveExternalDataSourceConfig(source, {}, { eeaNoiseServiceBaseUrl: 'https://noise.discomap.eea.europa.eu/arcgis/rest/services/noiseStoryMap' })
    expect(resolved.values.serviceBaseUrl).toBe('https://noise.discomap.eea.europa.eu/arcgis/rest/services/noiseStoryMap')
    expect(resolved.isConfigured).toBe(true)
  })

  it('a DB override wins over env runtimeConfig', () => {
    const resolved = resolveExternalDataSourceConfig(
      source,
      { serviceBaseUrl: 'https://my-noise-mirror.example/services/noiseStoryMap' },
      { eeaNoiseServiceBaseUrl: 'https://noise.discomap.eea.europa.eu/arcgis/rest/services/noiseStoryMap' },
    )
    expect(resolved.values.serviceBaseUrl).toBe('https://my-noise-mirror.example/services/noiseStoryMap')
  })
})

describe('stored external-data source config (DB round-trip)', () => {
  it('returns {} for a source with nothing stored yet', async () => {
    const db = makeFakePool()
    expect(await getStoredExternalDataSourceConfig(db, 'eea-environmental-noise-directive')).toEqual({})
  })

  it('saves and re-reads a source config, dropping invalid/empty fields', async () => {
    const db = makeFakePool()
    const saved = await setStoredExternalDataSourceConfig(db, 'eea-environmental-noise-directive', {
      serviceBaseUrl: '  https://noise.discomap.eea.europa.eu/arcgis/rest/services/noiseStoryMap  ',
      timeoutMs: 'not-a-number',
    })
    expect(saved).toEqual({ serviceBaseUrl: 'https://noise.discomap.eea.europa.eu/arcgis/rest/services/noiseStoryMap' })
    expect(await getStoredExternalDataSourceConfig(db, 'eea-environmental-noise-directive')).toEqual(saved)
  })

  it('rejects an unknown/unconfigurable source id', async () => {
    const db = makeFakePool()
    await expect(setStoredExternalDataSourceConfig(db, 'eurostat-house-price-index', {})).rejects.toThrow()
  })

  it('bulk-reads every configurable source in one call', async () => {
    const db = makeFakePool()
    await setStoredExternalDataSourceConfig(db, 'fr-dvf-geolocated', { cachePath: '/app/.cache_zvg/external/fr-dvf.json' })
    const all = await getAllStoredExternalDataSourceConfigs(db)
    expect(all['fr-dvf-geolocated']).toEqual({ cachePath: '/app/.cache_zvg/external/fr-dvf.json' })
    expect(all['cams-air-quality']).toEqual({})
  })
})
