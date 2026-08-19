import type { RegionInfo } from '../types'

export const BASE_URL = 'https://www.kip.net'
export const PLATFORM_ID = 'kip'
export const COUNTRY = 'de'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/** kip.net (Betreiber: immovativ GmbH, Hanau) ist eine Kauf-/Mietbörse ohne
 *  Gerichtsbezug — Angebote kommen von Kommunen, Maklern und Privatpersonen
 *  gemischt, ein "Anbieter" pro Objekt ist auf der Detailseite fast immer
 *  genannt (siehe detail.ts). Dieser Fallback greift nur, wenn dieser Block
 *  auf einer Detailseite ausnahmsweise fehlt. */
export const FALLBACK_AUTHORITY = 'immovativ GmbH (KIP)'

/** kip.net's robots.txt (verified live) declares "Crawl-delay: 1" for
 *  User-agent: * — every request this adapter makes (listing pages,
 *  pagination, detail pages) funnels through fetch.ts's shared queue, which
 *  enforces this project-wide. */
export const CRAWL_DELAY_MS = 1_000

/**
 * PoC scope: two city-states with no further Kreis/Gemeinde split in kip.net's
 * own sitemap (.../bremen/sitemap.xml and .../hamburg/sitemap.xml each list
 * only the state's own landing page, unlike e.g. Saarland's ~50 per-Gemeinde
 * sitemaps) — verified live 2026-08-19. That keeps each region to one flat
 * "<state>/kaufen/<category>" listing URL per category instead of first
 * having to discover and crawl dozens of municipality pages. Codes reuse the
 * project convention also used by mv-zvgcom/dga-ag for these two states.
 */
export const KIP_REGIONS: readonly RegionInfo[] = [
  { code: 'hb', name: 'Bremen' },
  { code: 'hh', name: 'Hamburg' },
] as const

/** kip.net's own state-level URL slug for each registered region code. */
export const KIP_STATE_SLUG: Record<string, string> = {
  hb: 'bremen',
  hh: 'hamburg',
}

export interface KipCategory {
  /** URL path segment under /<state>/kaufen/. */
  slug: string
  /** Hidden form field that gates this category's listing/pagination form
   *  (e.g. <input type="hidden" name="filter_haus" value="1">) — required on
   *  every paginated POST, see list.ts. */
  filterField: string
}

/**
 * kip.net splits every state into "kaufen" (buy) and "mieten" (rent) from the
 * URL up (confirmed live via the sitemap and the page's own nav: .../kaufen/*
 * vs. .../mieten/*) — a clean, structural buy/rent split. Auction.marketValueEur
 * models a one-off price, not a monthly rent, and the data model has no
 * separate rent field, so this PoC only ever requests these three "kaufen"
 * category pages (all three verified live to share the same list/detail
 * template; "sonstige-immobilien" currently has zero live listings in both
 * registered states, but is kept in scope since it costs nothing extra to
 * crawl and may fill up over time).
 */
export const KIP_CATEGORIES: readonly KipCategory[] = [
  { slug: 'haeuser', filterField: 'filter_haus' },
  { slug: 'eigentumswohnungen', filterField: 'filter_wohnung' },
  { slug: 'sonstige-immobilien', filterField: 'filter_sonstige' },
] as const
