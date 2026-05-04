import type { CrawlResult } from '~/types/auction'
import type { BundeslandInfo, CrawlOptions, PlatformCrawler } from './types'
import { zvgPortalCrawler } from './zvg-portal'

/**
 * All registered platform crawlers. Adding a new platform is purely additive:
 * 1. Implement the PlatformCrawler interface in server/crawlers/<name>/.
 * 2. Append it here.
 * If two platforms claim the same Bundesland, the first one wins.
 */
export const platforms: readonly PlatformCrawler[] = [zvgPortalCrawler] as const

export interface BundeslandEntry extends BundeslandInfo {
  platformId: string
  platformName: string
}

export function listBundeslaender(): BundeslandEntry[] {
  const seen = new Set<string>()
  const entries: BundeslandEntry[] = []
  for (const p of platforms) {
    for (const b of p.bundeslaender) {
      if (seen.has(b.abk)) continue
      seen.add(b.abk)
      entries.push({ ...b, platformId: p.id, platformName: p.name })
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'de'))
}

export function getCrawlerForLand(abk: string): PlatformCrawler | null {
  const norm = abk.toLowerCase()
  for (const p of platforms) {
    if (p.bundeslaender.some((b) => b.abk === norm)) return p
  }
  return null
}

/**
 * Crawl one Bundesland via the platform that owns it.
 */
export async function crawlSingle(opts: CrawlOptions): Promise<CrawlResult> {
  const crawler = getCrawlerForLand(opts.bundesland)
  if (!crawler) {
    throw new Error(`Kein Crawler für Bundesland "${opts.bundesland}" registriert`)
  }
  return await crawler.crawl(opts)
}

/**
 * Crawl every registered Bundesland and merge into one result.
 *
 * Concurrency: states run in parallel up to `stateConcurrency`. Inside a state,
 * the crawler does its own detail-fetch concurrency. Failures in individual
 * states don't abort the whole run — they show up as zero auctions for that
 * state and are returned in `errors`.
 */
export async function crawlAll(
  opts: Omit<CrawlOptions, 'bundesland'> & { stateConcurrency?: number } = {},
): Promise<CrawlResult & { errors: { bundesland: string; message: string }[] }> {
  const concurrency = opts.stateConcurrency ?? 4
  const all = listBundeslaender()
  const results: CrawlResult[] = []
  const errors: { bundesland: string; message: string }[] = []

  let cursor = 0
  async function worker() {
    while (cursor < all.length) {
      const idx = cursor++
      const b = all[idx]
      try {
        const r = await crawlSingle({
          bundesland: b.abk,
          immobilienOnly: opts.immobilienOnly,
          enrichDetails: opts.enrichDetails,
        })
        results.push(r)
      } catch (err) {
        errors.push({ bundesland: b.abk, message: (err as Error).message })
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
    bundeslaender: all.map((b) => b.name),
    fetchedAt: new Date().toISOString(),
    totalReported,
    auctions: merged,
    errors,
  }
}
