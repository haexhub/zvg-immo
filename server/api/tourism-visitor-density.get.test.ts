import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearCachedFileCollections } from '~/server/utils/external-data/cached-file-collection'
import type { TourismNutsCollection } from '~/server/utils/external-data/eurostat-tourism-nuts'

vi.mock('~/server/utils/db', () => ({ getPool: vi.fn(() => null) }))

let tmp: string | null = null

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
  clearCachedFileCollections()
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = null
})

function stubHandlerGlobals(runtimeConfig: Record<string, unknown>): { setResponseHeader: ReturnType<typeof vi.fn> } {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('useRuntimeConfig', () => ({ externalData: runtimeConfig }))
  const setResponseHeader = vi.fn()
  vi.stubGlobal('setResponseHeader', setResponseHeader)
  return { setResponseHeader }
}

describe('/api/tourism-visitor-density', () => {
  it('returns available:false without touching the filesystem when the source has no configured cache path', async () => {
    stubHandlerGlobals({})
    const handler = (await import('./tourism-visitor-density.get')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({ available: false, unit: 'P_KM2', generatedAt: '', breaks: [], regions: [] })
  })

  it('returns available:false (not an error) when the cache path is configured but the file was never written', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tourism-visitor-density-'))
    const cachePath = join(tmp, 'never-imported.json')
    stubHandlerGlobals({ eurostatTourismNutsCachePath: cachePath })
    const handler = (await import('./tourism-visitor-density.get')).default as unknown as (event: unknown) => Promise<unknown>

    await expect(handler({})).resolves.toEqual({ available: false, unit: 'P_KM2', generatedAt: '', breaks: [], regions: [] })
  })

  it('serves the cached collection and sets a long cache-control once imported', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'tourism-visitor-density-'))
    const cachePath = join(tmp, 'eurostat-tourism-nuts.json')
    const collection: TourismNutsCollection = {
      generatedAt: '2026-08-22T00:00:00.000Z',
      sourceVersion: 'test-v1',
      unit: 'P_KM2',
      breaks: [10, 20],
      regions: [{
        nutsId: 'AT13',
        name: 'Kärnten',
        countryCode: 'AT',
        value: 15,
        dataYear: '2024',
        bin: 1,
        geometry: { type: 'Polygon', coordinates: [[[14, 46], [14.5, 46], [14.5, 46.5], [14, 46]]] },
      }],
    }
    await writeFile(cachePath, JSON.stringify(collection))
    const { setResponseHeader } = stubHandlerGlobals({ eurostatTourismNutsCachePath: cachePath })

    const handler = (await import('./tourism-visitor-density.get')).default as unknown as (event: unknown) => Promise<unknown>
    const response = await handler({})

    expect(response).toEqual({
      available: true,
      unit: 'P_KM2',
      generatedAt: '2026-08-22T00:00:00.000Z',
      breaks: [10, 20],
      regions: collection.regions,
    })
    expect(setResponseHeader).toHaveBeenCalledWith({}, 'cache-control', 'public, max-age=3600')
  })
})
