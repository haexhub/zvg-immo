import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/external-data/effis-wildfire', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/external-data/effis-wildfire')>()
  return {
    ...actual,
    importEffisCurrentFireDangerCache: vi.fn(),
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('import-effis-wildfire-cache task', () => {
  it('imports EFFIS current fire danger with official defaults', async () => {
    vi.stubGlobal('defineTask', (def: unknown) => def)
    const { importEffisCurrentFireDangerCache, EFFIS_WMS_URL } = await import('~/server/utils/external-data/effis-wildfire')
    vi.mocked(importEffisCurrentFireDangerCache).mockResolvedValue({
      cachePath: '/tmp/effis-wildfire.json',
      serviceUrl: EFFIS_WMS_URL,
      sourceVersion: 'effis-test',
      generatedAt: '2026-07-26T00:00:00.000Z',
      validFor: '2026-07-26',
      requested: 1,
      sampled: 1,
    })

    const { runImportEffisWildfireCache } = await import('./import-effis-wildfire-cache')
    await expect(runImportEffisWildfireCache({
      cachePath: '/tmp/effis-wildfire.json',
      generatedAt: '2026-07-26T00:00:00.000Z',
      validFor: '2026-07-26',
      points: [{ lat: 48.8566, lng: 2.3522 }],
    })).resolves.toMatchObject({ sampled: 1 })

    expect(importEffisCurrentFireDangerCache).toHaveBeenCalledWith({
      cachePath: '/tmp/effis-wildfire.json',
      serviceUrl: EFFIS_WMS_URL,
      sourceVersion: undefined,
      generatedAt: '2026-07-26T00:00:00.000Z',
      validFor: '2026-07-26',
      ttlHours: undefined,
      points: [{ lat: 48.8566, lng: 2.3522 }],
    })
  })
})
