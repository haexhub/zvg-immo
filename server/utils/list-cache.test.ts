import { describe, expect, it, vi } from 'vitest'
import type { CrawlResult } from '~/types/auction'

const files: Record<string, CrawlResult> = {
  'de-by.json': {
    platform: 'zvg-portal',
    source: 'zvg-portal',
    countries: ['de'],
    regions: ['Bayern'],
    fetchedAt: '2026-01-01T00:00:00.000Z',
    totalReported: 1,
    auctions: [{ platform: 'zvg-portal', externalId: '1' } as CrawlResult['auctions'][number]],
  },
  'fr-idf.json': {
    platform: 'licitor',
    source: 'licitor',
    countries: ['fr'],
    regions: ['Île-de-France'],
    fetchedAt: '2026-01-01T00:00:00.000Z',
    totalReported: 1,
    auctions: [{ platform: 'licitor', externalId: '2' } as CrawlResult['auctions'][number]],
  },
}

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(async () => Object.keys(files)),
  readFile: vi.fn(async (path: string) => {
    const name = Object.keys(files).find((f) => path.endsWith(f))
    if (!name) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return JSON.stringify(files[name])
  }),
  stat: vi.fn(async () => ({ mtimeMs: 0 })),
}))

const { readListCache, readMergedListCache } = await import('./list-cache')

describe('list-cache country pause', () => {
  it('readListCache returns null for a paused country without reading the file', async () => {
    expect(await readListCache('fr', 'idf')).toBeNull()
  })

  it('readListCache still serves an enabled country', async () => {
    const result = await readListCache('de', 'by')
    expect(result?.auctions).toHaveLength(1)
  })

  it('readMergedListCache (all scope) excludes paused-country files', async () => {
    const result = await readMergedListCache()
    expect(result?.auctions.map((a) => a.platform)).toEqual(['zvg-portal'])
  })
})
