import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CrawlResult } from '~/types/auction'

const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'list')

function cacheFile(country: string, region: string): string {
  return join(CACHE_DIR, `${country}-${region}.json`)
}

export async function readListCache(country: string, region: string): Promise<CrawlResult | null> {
  try {
    const raw = await readFile(cacheFile(country, region), 'utf8')
    return JSON.parse(raw) as CrawlResult
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.warn(`[list-cache] read ${country}/${region}: ${(err as Error).message}`)
    return null
  }
}

export async function writeListCache(
  country: string,
  region: string,
  result: CrawlResult,
): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true })
  const path = cacheFile(country, region)
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(result))
  await rename(tmp, path)
}

/**
 * Merge all cached region results, optionally filtered to one country.
 * Returns null when the cache directory doesn't exist or is empty.
 */
export async function readMergedListCache(country?: string): Promise<CrawlResult | null> {
  let entries: string[]
  try {
    entries = await readdir(CACHE_DIR)
  } catch {
    return null
  }
  const prefix = country ? `${country}-` : ''
  const files = entries.filter((f) => f.endsWith('.json') && (!prefix || f.startsWith(prefix)))
  if (files.length === 0) return null

  const results: CrawlResult[] = []
  for (const file of files) {
    try {
      const raw = await readFile(join(CACHE_DIR, file), 'utf8')
      results.push(JSON.parse(raw) as CrawlResult)
    } catch {
      // skip corrupt files
    }
  }
  if (results.length === 0) return null

  return {
    platform: 'multi',
    source: [...new Set(results.map((r) => r.source))].join(', '),
    countries: [...new Set(results.flatMap((r) => r.countries))],
    regions: [...new Set(results.flatMap((r) => r.regions))],
    fetchedAt: results.reduce((latest, r) => (r.fetchedAt > latest ? r.fetchedAt : latest), ''),
    totalReported: null,
    auctions: results.flatMap((r) => r.auctions),
  }
}
