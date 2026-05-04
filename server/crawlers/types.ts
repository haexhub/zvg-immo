import type { CrawlResult } from '~/types/auction'

export interface BundeslandInfo {
  /** Two-letter Kfz-style abbreviation, e.g. 'sn' for Sachsen. */
  abk: string
  /** Full German name, e.g. 'Sachsen'. */
  name: string
}

export interface CrawlOptions {
  bundesland: string
  immobilienOnly?: boolean
  enrichDetails?: boolean
}

/**
 * A single auction-source platform. The same platform may serve multiple
 * Bundesländer (e.g. zvg-portal.de is shared by all 16 states).
 */
export interface PlatformCrawler {
  /** Stable machine id, used to tag auctions with their source. */
  id: string
  /** Human-readable name shown in the UI. */
  name: string
  /** Public URL of the platform — used for attribution and as a fallback. */
  baseUrl: string
  /** Which Bundesländer this crawler can serve. */
  bundeslaender: readonly BundeslandInfo[]
  crawl(opts: CrawlOptions): Promise<CrawlResult>
}
