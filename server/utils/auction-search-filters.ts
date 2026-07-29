// Shared WHERE-clause builder for the two public search endpoints:
// /api/auctions (paginated cards) and /api/auctions-geo (markers only). Both
// must agree exactly — a marker the list cannot show, or a card missing from
// the map, reads to the user as a broken filter — so the predicate lives here
// once instead of being copied per endpoint.

import type { Pool } from 'pg'
import { ensureEnabledCountriesLoaded, getEnabledCountryCodes } from '~/server/crawlers/registry'
import { getHideRulesOnlyAuctions } from '~/server/utils/app-settings'

export interface AuctionSearchFilter {
  /** `WHERE …`, or '' when nothing is constrained. */
  predicate: string
  /** Positional parameters for `predicate`, starting at $1. */
  values: unknown[]
}

export function commaList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '')
  return [...new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))]
}

/** '' must yield null, not Number('') === 0 — callers use null to mean "unset". */
export function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(Array.isArray(value) ? value[0] : value)
  return Number.isFinite(parsed) ? parsed : null
}

export async function buildAuctionSearchFilter(
  db: Pool,
  query: Record<string, unknown>,
): Promise<AuctionSearchFilter> {
  const values: unknown[] = []
  const where: string[] = []
  const add = (value: unknown): string => {
    values.push(value)
    return `$${values.length}`
  }

  // A paused country keeps its raw data, history, watchlists and permalinks but
  // must stop surfacing in discovery (see server/crawlers/registry.ts). The
  // serving tables are never pruned on pause, so the enabled set has to be
  // applied here — unlike the list caches this replaced, which filtered on read.
  await ensureEnabledCountriesLoaded()
  const enabled = getEnabledCountryCodes()
  const requested = commaList(query.country)
    .filter((entry) => /^[a-z]{2}$/i.test(entry))
    .map((entry) => entry.toLowerCase())
  const countries = requested.length ? requested.filter((entry) => enabled.includes(entry)) : enabled
  where.push(`a.country = ANY(${add(countries)}::text[])`)

  const regionNames = commaList(query.regionNames)
  if (regionNames.length) where.push(`(a.country || ':' || a.region) = ANY(${add(regionNames)}::text[])`)

  const search = String(query.q ?? '').trim()
  if (search) {
    where.push(`concat_ws(' ', a.case_number, a.authority, a.title, a.address, a.description) ILIKE ${add(`%${search}%`)}`)
  }
  const authority = String(query.authority ?? '')
  if (authority && authority !== 'all') where.push(`a.authority = ${add(authority)}`)
  const category = String(query.category ?? '')
  if (category && category !== 'all') where.push(`a.property_type = ${add(category)}`)
  const condition = String(query.condition ?? '')
  if (condition && condition !== 'all') where.push(`a.condition #>> '{}' = ${add(condition)}`)
  const features = commaList(query.features)
  if (features.length) where.push(`a.features && ${add(features)}::text[]`)
  if (String(query.photos ?? '') === '1') where.push('a.photo_count > 0')
  if (String(query.cancelled ?? '') !== '1') where.push('a.cancelled = false')

  // pages/search.vue only puts llmOnly in the URL when the user overrode the
  // admin-configured default (/api/display-settings), so an absent parameter
  // means "use that default" — not "no filter".
  const llmOnlyParam = String(query.llmOnly ?? '')
  const hideRulesOnly = llmOnlyParam === '1'
    ? true
    : llmOnlyParam === '0'
      ? false
      : await getHideRulesOnlyAuctions(db)
  if (hideRulesOnly) {
    where.push(`(
      a.extraction_source = 'llm'
      OR ec.extraction ? 'llmAnalyzedAt'
      OR ec.extraction ? 'condition'
      OR ec.extraction ? 'features'
      OR ec.extraction ? 'insights'
    )`)
  }

  const ranges: Array<[unknown, string, '>=' | '<=']> = [
    [query.priceMin, 'a.market_value_eur', '>='],
    [query.priceMax, 'a.market_value_eur', '<='],
    [query.landMin, 'a.land_area_sqm', '>='],
    [query.landMax, 'a.land_area_sqm', '<='],
    [query.livMin, 'a.living_area_sqm', '>='],
    [query.livMax, 'a.living_area_sqm', '<='],
    [query.yearBuiltMin, 'a.year_built', '>='],
    [query.yearBuiltMax, 'a.year_built', '<='],
    [query.renovationYearMin, 'a.last_renovation_year', '>='],
    [query.renovationYearMax, 'a.last_renovation_year', '<='],
  ]
  for (const [raw, column, operator] of ranges) {
    const value = finiteNumber(raw)
    if (value != null) where.push(`${column} ${operator} ${add(value)}`)
  }

  return { predicate: where.length ? `WHERE ${where.join(' AND ')}` : '', values }
}
