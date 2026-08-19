import type { RegionInfo } from '../types'

export const PLATFORM_ID = 'bg-alo'
export const COUNTRY = 'bg'
export const BASE_URL = 'https://www.alo.bg'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/**
 * alo.bg is Bulgaria's largest private classifieds marketplace — no court
 * reference, same "no case number to publish" shape as kip.net. Verified
 * live (2026-08-19): ~154,000 active for-sale listings nationwide across 10
 * property subcategories x 28 oblasti, with no reliable incremental crawl
 * path (robots.txt disallows the site's own `?order_by=` sort parameter, and
 * the default sort interleaves paid VIP/TOP placements ahead of a strict
 * newest-first order, so a full page walk is the only way to find new
 * listings). Scoped down the same way kip.net was: the two largest oblasti
 * (Sofia, Plovdiv — the biggest markets) and the two most "Schnäppchen"-
 * relevant subcategories (apartments, houses) — ~34,000 listings, ~1,140
 * pages per full crawl cycle.
 *
 * Exposes a single nationwide 'all' scope rather than registering 'sofia'/
 * 'plovdiv' as selectable sub-regions — bg/zapori (and sales.bcpea.org) are
 * already registered under 'all' for this country, and registry.test.ts
 * enforces that a country's platforms never mix ALL_SCOPE with real
 * sub-region codes (a per-region refresh pass over the 'all' entry would
 * otherwise re-crawl this same PoC scope on top of its own dedicated
 * 'sofia'/'plovdiv' passes). Each auction still carries its real oblast name
 * in `Auction.region` — see OBLASTI below — same "coarse crawler scope, fine
 * per-auction region" split bcpea uses for its court districts.
 */
export const ALO_REGIONS: readonly RegionInfo[] = [{ code: 'all', name: 'Bulgarien' }] as const

export interface AloOblast {
  /** Internal code, never exposed as a CrawlOptions region scope (see
   *  ALO_REGIONS above) — only used to key OBLASTI itself. */
  code: string
  /** Human-readable oblast name, written into each Auction's `region`. */
  name: string
  /** alo.bg's own numeric region id — global to the site (shared across
   *  every category), read live from the region-overview grid. */
  regionId: string
}

/** The two PoC-scoped oblasti (see the module doc comment above). */
export const ALO_OBLASTI: readonly AloOblast[] = [
  { code: 'sofia', name: 'София', regionId: '22' },
  { code: 'plovdiv', name: 'Пловдив', regionId: '16' },
] as const

export interface AloCategory {
  /** URL path segment under /obiavi/imoti-prodajbi/. */
  slug: string
}

export const ALO_CATEGORIES: readonly AloCategory[] = [
  { slug: 'apartamenti-stai' },
  { slug: 'kashti-vili' },
] as const

/** Plovdiv apartments alone runs ~630 pages at 30 listings/page (verified
 *  live) — comfortably above that even as the catalog grows.
 *  fetchAllListings (list.ts) stops as soon as a page 404s or comes back
 *  empty rather than relying on this cap in the normal case. */
export const MAX_PAGES = 700

/** "Тристаен апартамент..." room-count adjectives prefixing the "Вид на
 *  имота" (property type) field on apartment listings — the only place a
 *  room count is available; houses expose no equivalent field. */
export const ROOM_COUNT_BY_PREFIX: Record<string, number> = {
  едностаен: 1,
  двустаен: 2,
  тристаен: 3,
  четиристаен: 4,
  многостаен: 5,
}

/** A sizeable share of listings (verified live, e.g. single-floor-of-a-house
 *  offers) carry no publisher name at all — private sellers with no agency
 *  logo — unlike agency-branded ads whose publisher name is always present. */
export const FALLBACK_AUTHORITY = 'Частно лице (alo.bg)'
