import type { CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler, RegionInfo } from './types'
import { zvgPortalCrawler } from './zvg-portal'

/**
 * All registered platform crawlers. Adding a new platform is purely additive:
 * 1. Implement the PlatformCrawler interface in server/crawlers/<name>/.
 * 2. Append it here.
 * Multiple platforms may share the same country (e.g. several private auction
 * sites for one nation); the country code distinguishes regions.
 */
export const platforms: readonly PlatformCrawler[] = [zvgPortalCrawler] as const

export interface RegionEntry extends RegionInfo {
  country: string
  platformId: string
  platformName: string
}

export interface CountryEntry {
  /** ISO 3166-1 alpha-2, lowercase. */
  code: string
  /** Localised display name (German). */
  name: string
  regions: RegionEntry[]
}

const COUNTRY_NAMES: Record<string, string> = {
  de: 'Deutschland',
  at: 'Österreich',
  es: 'Spanien',
  it: 'Italien',
  cz: 'Tschechien',
  pl: 'Polen',
}

export function listRegions(): RegionEntry[] {
  const seen = new Set<string>()
  const entries: RegionEntry[] = []
  for (const p of platforms) {
    for (const r of p.regions) {
      const key = `${p.country}:${r.code}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({
        ...r,
        country: p.country,
        platformId: p.id,
        platformName: p.name,
      })
    }
  }
  return entries.sort(
    (a, b) =>
      a.country.localeCompare(b.country) || a.name.localeCompare(b.name, 'de'),
  )
}

export function listCountries(): CountryEntry[] {
  const grouped = new Map<string, RegionEntry[]>()
  for (const r of listRegions()) {
    const arr = grouped.get(r.country) ?? []
    arr.push(r)
    grouped.set(r.country, arr)
  }
  return [...grouped.entries()]
    .map(([code, regions]) => ({
      code,
      name: COUNTRY_NAMES[code] ?? code.toUpperCase(),
      regions,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
}

export function getCrawlerForRegion(country: string, regionCode: string): PlatformCrawler | null {
  const c = country.toLowerCase()
  const r = regionCode.toLowerCase()
  for (const p of platforms) {
    if (p.country !== c) continue
    if (p.regions.some((reg) => reg.code === r)) return p
  }
  return null
}

/**
 * Crawl one region via the platform that owns it.
 */
export async function crawlSingle(
  opts: CrawlOptions & { country: string },
): Promise<CrawlResult> {
  const crawler = getCrawlerForRegion(opts.country, opts.region)
  if (!crawler) {
    throw new Error(
      `Kein Crawler für ${opts.country}/${opts.region} registriert`,
    )
  }
  return await crawler.crawl(opts)
}

export interface CrawlAllOptions {
  immobilienOnly?: boolean
  enrichDetails?: boolean
  /** Restrict to one country (ISO-2). Omit/null = all registered countries. */
  country?: string | null
  /** Max parallel region fetches across all platforms. */
  regionConcurrency?: number
}

/**
 * Crawl every registered region (optionally filtered to one country) and merge
 * into one result.
 *
 * Concurrency: regions run in parallel up to `regionConcurrency`. Inside a
 * crawler, the implementation does its own detail-fetch concurrency. Failures
 * in individual regions don't abort the whole run — they show up as zero
 * auctions for that region and are returned in `errors`.
 */
export async function crawlAll(
  opts: CrawlAllOptions = {},
): Promise<CrawlResult & { errors: { country: string; region: string; message: string }[] }> {
  const concurrency = opts.regionConcurrency ?? 4
  const all = listRegions().filter(
    (r) => !opts.country || r.country === opts.country.toLowerCase(),
  )
  const results: CrawlResult[] = []
  const errors: { country: string; region: string; message: string }[] = []

  let cursor = 0
  async function worker() {
    while (cursor < all.length) {
      const idx = cursor++
      const r = all[idx]
      if (!r) continue
      try {
        const result = await crawlSingle({
          country: r.country,
          region: r.code,
          immobilienOnly: opts.immobilienOnly,
          enrichDetails: opts.enrichDetails,
        })
        results.push(result)
      } catch (err) {
        errors.push({
          country: r.country,
          region: r.code,
          message: (err as Error).message,
        })
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))

  const merged = results.flatMap((r) => r.auctions)
  const totalReported = results.reduce<number | null>(
    (sum, r) => (r.totalReported == null ? sum : (sum ?? 0) + r.totalReported),
    null,
  )

  return {
    platform: 'multi',
    source: [...new Set(results.map((r) => r.source))].join(', '),
    countries: [...new Set(results.flatMap((r) => r.countries))],
    regions: [...new Set(results.flatMap((r) => r.regions))],
    fetchedAt: new Date().toISOString(),
    totalReported,
    auctions: merged,
    errors,
  }
}
