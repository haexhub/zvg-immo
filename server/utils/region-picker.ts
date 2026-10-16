// Region options for the search/landing region picker. The crawler registry's
// regions are a *crawl-scope* taxonomy: a nationwide-only platform registers
// one ALL_SCOPE pseudo-region named after the country, because the scheduler
// needs something to crawl. PR #439 stopped offering that entry as a filter
// (it can never narrow anything down), which left those countries with no
// region block at all — even though several of their crawlers do write a real
// per-auction region: pl a voivodeship, cz a district, is a location, gb a
// constituent country. This module recovers those names from the stored
// auctions, so the picker offers the regions that actually exist.

import { ALL_SCOPE } from '~/lib/auction-constants'
import type { CountryEntry } from '../crawlers/registry'
import { getPool } from './db'

/** A country whose every registered region is the ALL_SCOPE pseudo-entry —
 *  the registry knows no real sub-region code for it, so its picker options
 *  can only come from the stored auctions. Countries with genuine sub-region
 *  codes (de, se, ca, ...) keep using the registry, whose codes are also what
 *  saved searches and permalinks already hold. */
export function isNationwideOnlyCountry(country: { regions: Array<{ code: string }> }): boolean {
  return country.regions.length > 0 && country.regions.every((region) => region.code === ALL_SCOPE)
}

/**
 * The distinct, non-empty `Auction.region` values these countries currently
 * serve. Cancelled rows and auctions whose date has passed are excluded so a
 * region that only exists on withdrawn or concluded listings doesn't become
 * another dead option — the search itself always applies both conditions
 * (see auction-search-filters.ts). Returns an empty map without Postgres,
 * which is exactly the post-#439 payload: no region block.
 */
export async function readStoredRegionNames(countryCodes: string[]): Promise<Map<string, string[]>> {
  const byCountry = new Map<string, string[]>()
  const db = getPool()
  if (!db || countryCodes.length === 0) return byCountry
  const { rows } = await db.query<{ country: string; region: string }>(
    // A name with a comma is skipped rather than offered: the picker's keys
    // travel comma-joined in the search URL (see the region param in
    // lib/auction-search-filter-contract.ts), so such an option would split
    // into two keys that resolve to nothing. Only free-form region text can
    // hit this (is writes the auction venue's town verbatim).
    `SELECT country, region FROM auctions
      WHERE country = ANY($1) AND region <> '' AND region NOT LIKE '%,%' AND cancelled = false
        AND (auction_date_iso IS NULL OR auction_date_iso >= now())
      GROUP BY country, region
      ORDER BY country, region`,
    [countryCodes],
  )
  for (const row of rows) {
    byCountry.set(row.country, [...(byCountry.get(row.country) ?? []), row.region])
  }
  return byCountry
}

/**
 * Projects the registry's countries into picker options: real sub-regions stay
 * as they are (minus any stray ALL_SCOPE entry), a nationwide-only country gets
 * its stored region names instead. Those carry the name as their own code,
 * because the search filter resolves a `country:code` key to `country:name`
 * (composables/useAuctionSearchState.ts) and compares that against
 * `country || ':' || a.region` in SQL — for a name-as-code entry that
 * resolution is the identity. alert-matching.ts resolves the same keys
 * server-side and mirrors the rule.
 */
export function applyPickerRegions(
  countries: CountryEntry[],
  storedByCountry: Map<string, string[]>,
): CountryEntry[] {
  return countries.map((country) => {
    if (!isNationwideOnlyCountry(country)) {
      return { ...country, regions: country.regions.filter((region) => region.code !== ALL_SCOPE) }
    }
    // Every platform of a nationwide-only country serves every one of its
    // regions, so the ALL_SCOPE entry's platform list carries over unchanged.
    const platforms = country.regions[0]?.platforms ?? []
    const names = storedByCountry.get(country.code) ?? []
    return {
      ...country,
      regions: names.map((name) => ({ code: name, name, country: country.code, platforms })),
    }
  })
}
