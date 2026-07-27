import type { Auction, CrawlResult } from '~/types/auction'
import { normalizeAuctionDescriptions } from '~/server/utils/description-normalization'

interface CrawlResultInput {
  platform: string
  source: string
  country: string
  regions: readonly RegionInfo[]
  totalReported: number | null
  auctions: Auction[]
}

export function createCrawlResult(input: CrawlResultInput): CrawlResult {
  normalizeAuctionDescriptions(input.auctions)
  return {
    platform: input.platform,
    source: input.source,
    countries: [input.country],
    regions: input.regions.map((r) => r.name),
    fetchedAt: new Date().toISOString(),
    totalReported: input.totalReported,
    auctions: input.auctions,
  }
}

export interface RegionInfo {
  /** Internal region code as used by the platform (e.g. 'sn' for Sachsen).
   *  Use 'all' when the platform does not expose a sub-region filter. */
  code: string
  /** Human-readable region name (e.g. 'Sachsen', 'Madrid'). */
  name: string
}

export interface CrawlOptions {
  /** Region code within the platform's country. Use 'all' for platforms
   *  that don't subdivide. */
  region: string
  immobilienOnly?: boolean
  enrichDetails?: boolean
}

/**
 * A single auction-source platform. Each crawler is bound to exactly one
 * country; a country may be served by multiple crawlers in the future.
 */
export interface PlatformCrawler {
  /** Stable machine id, used to tag auctions with their source. */
  id: string
  /** Human-readable name shown in the UI. */
  name: string
  /** Public URL of the platform — used for attribution and as a fallback. */
  baseUrl: string
  /** ISO 3166-1 alpha-2 country code, lowercase ('de', 'es', 'at', ...). */
  country: string
  /** Sub-regions this crawler can serve. National-only platforms expose a
   *  single entry with code='all'. */
  regions: readonly RegionInfo[]
  crawl(opts: CrawlOptions): Promise<CrawlResult>
  /** Enrich a single already-listed auction in place with its detail-page data
   *  (description, attachments, …). Lets the enrich task fetch detail only for
   *  auctions not yet in the extraction cache, instead of re-enriching every
   *  listing on every run (which would hammer the upstream portals). Optional —
   *  a crawler that can't enrich one item in isolation omits it. */
  enrichOne?(auction: Auction): Promise<void>
  /** Optional fast path for permalink/detail pages whose snapshot entry has
   *  not been written yet. Returns one fully mapped listing without crawling
   *  the whole region. */
  findOne?(externalId: string): Promise<Auction | null>
}
