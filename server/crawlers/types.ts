import type { CrawlResult } from '~/types/auction'

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
}
