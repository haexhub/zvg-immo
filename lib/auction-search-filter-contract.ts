// The public URL and saved-search contract.  Keep this module framework and
// server-runtime agnostic: callers may turn these values into Vue refs or SQL,
// but parsing, defaults and URL spellings belong here exactly once.

import { ALL_SCOPE } from '~/lib/auction-constants'

export const SORT_OPTIONS = ['default', 'dateAsc', 'priceAsc', 'priceDesc'] as const
export type AuctionSearchSortBy = typeof SORT_OPTIONS[number]

export interface AuctionSearchFilters {
  countries: string[]
  /** UI keys (`de:sn`), deliberately distinct from the resolved `regionNames`
   * used by the database query. */
  regionKeys: string[]
  search: string
  authority: string
  priceMin: number | null
  priceMax: number | null
  landMin: number | null
  landMax: number | null
  livMin: number | null
  livMax: number | null
  yearBuiltMin: number | null
  yearBuiltMax: number | null
  renovationYearMin: number | null
  renovationYearMax: number | null
  nearSea: number | null
  nearLake: number | null
  nearRiver: number | null
  nearMountain: number | null
  nearAirport: number | null
  nearSki: number | null
  urbanRural: string
  nearLat: number | null
  nearLng: number | null
  nearRadius: number | null
  category: string
  condition: string
  features: string[]
  onlyWithPhotos: boolean
  includeCancelled: boolean
  hideRulesOnly: boolean
  sortBy: AuctionSearchSortBy
}

export type SearchFilterQuery = Record<string, unknown>

export const AUCTION_SEARCH_FILTER_URL_KEYS = [
  'country', 'region', 'q', 'authority', 'priceMin', 'priceMax', 'landMin', 'landMax',
  'livMin', 'livMax', 'yearBuiltMin', 'yearBuiltMax', 'renovationYearMin',
  'renovationYearMax', 'nearSea', 'nearLake', 'nearRiver', 'nearMountain',
  'nearAirport', 'nearSki', 'urbanRural', 'nearLat', 'nearLng', 'nearRadius',
  'category', 'condition', 'features', 'photos', 'cancelled', 'llmOnly', 'sort',
] as const

const NUMBER_KEYS = [
  'priceMin', 'priceMax', 'landMin', 'landMax', 'livMin', 'livMax', 'yearBuiltMin',
  'yearBuiltMax', 'renovationYearMin', 'renovationYearMax', 'nearSea', 'nearLake',
  'nearRiver', 'nearMountain', 'nearAirport', 'nearSki', 'nearLat', 'nearLng',
  'nearRadius',
] as const

export const ALERT_UNSUPPORTED_FILTER_KEYS = [
  'nearSea', 'nearLake', 'nearRiver', 'nearMountain', 'nearAirport', 'nearSki', 'urbanRural',
] as const

function first(value: unknown): string {
  const item = Array.isArray(value) ? value[0] : value
  return typeof item === 'string' ? item : item == null ? '' : String(item)
}

export function commaList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(',') : first(value)
  return [...new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))]
}

export function finiteNumber(value: unknown): number | null {
  const raw = first(value)
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export function defaultAuctionSearchFilters(hideRulesOnly = false): AuctionSearchFilters {
  return {
    countries: [], regionKeys: [], search: '', authority: ALL_SCOPE,
    priceMin: null, priceMax: null, landMin: null, landMax: null, livMin: null, livMax: null,
    yearBuiltMin: null, yearBuiltMax: null, renovationYearMin: null, renovationYearMax: null,
    nearSea: null, nearLake: null, nearRiver: null, nearMountain: null, nearAirport: null, nearSki: null,
    urbanRural: ALL_SCOPE, nearLat: null, nearLng: null, nearRadius: null,
    category: ALL_SCOPE, condition: ALL_SCOPE, features: [], onlyWithPhotos: false,
    includeCancelled: false, hideRulesOnly, sortBy: 'default',
  }
}

export function parseAuctionSearchFilters(query: SearchFilterQuery, hideRulesOnlyDefault = false): AuctionSearchFilters {
  const defaults = defaultAuctionSearchFilters(hideRulesOnlyDefault)
  const parsed = { ...defaults,
    countries: commaList(query.country), regionKeys: commaList(query.region), search: first(query.q),
    authority: first(query.authority) || defaults.authority,
    urbanRural: first(query.urbanRural) || defaults.urbanRural,
    category: first(query.category) || defaults.category,
    condition: first(query.condition) || defaults.condition,
    features: commaList(query.features),
    onlyWithPhotos: first(query.photos) === '1', includeCancelled: first(query.cancelled) === '1',
    hideRulesOnly: first(query.llmOnly) === '1' ? true : first(query.llmOnly) === '0' ? false : hideRulesOnlyDefault,
  }
  for (const key of NUMBER_KEYS) parsed[key] = finiteNumber(query[key])
  // A coordinate pair without a radius is not "unbounded" — it must still be
  // an executable nearby filter for filterAuctions/SQL/alert matching, all of
  // which skip distance filtering entirely when nearRadius is null.
  if (parsed.nearLat != null && parsed.nearLng != null && parsed.nearRadius == null) {
    parsed.nearRadius = 25
  }
  const sort = first(query.sort)
  parsed.sortBy = SORT_OPTIONS.includes(sort as AuctionSearchSortBy) ? sort as AuctionSearchSortBy : 'default'
  return parsed
}

/** The server has an admin-controlled default; only an explicit URL override
 * may replace it.  Kept beside parsing so `0`, an empty value and absence
 * cannot drift between public search and saved-search hydration. */
export function hasExplicitHideRulesOnly(query: SearchFilterQuery): boolean {
  const value = first(query.llmOnly)
  return value === '1' || value === '0'
}

export function serializeAuctionSearchFilters(
  filters: AuctionSearchFilters,
  hideRulesOnlyDefault = false,
): Record<string, string> {
  const query: Record<string, string> = {}
  if (filters.countries.length) query.country = filters.countries.join(',')
  if (filters.regionKeys.length) query.region = filters.regionKeys.join(',')
  if (filters.search.trim()) query.q = filters.search.trim()
  if (filters.authority !== ALL_SCOPE) query.authority = filters.authority
  for (const key of NUMBER_KEYS) if (filters[key] != null) query[key] = String(filters[key])
  if (filters.urbanRural !== ALL_SCOPE) query.urbanRural = filters.urbanRural
  // Coordinates without a radius are not an active, executable nearby search.
  if (filters.nearLat == null || filters.nearLng == null) {
    delete query.nearLat
    delete query.nearLng
    delete query.nearRadius
  } else if (filters.nearRadius == null) {
    query.nearRadius = '25'
  }
  if (filters.category !== ALL_SCOPE) query.category = filters.category
  if (filters.condition !== ALL_SCOPE) query.condition = filters.condition
  if (filters.features.length) query.features = filters.features.join(',')
  if (filters.onlyWithPhotos) query.photos = '1'
  if (filters.includeCancelled) query.cancelled = '1'
  if (filters.hideRulesOnly !== hideRulesOnlyDefault) query.llmOnly = filters.hideRulesOnly ? '1' : '0'
  if (filters.sortBy !== 'default') query.sort = filters.sortBy
  return query
}

export function activeAuctionSearchFilterCount(filters: AuctionSearchFilters, hideRulesOnlyDefault = false): number {
  const query = serializeAuctionSearchFilters(filters, hideRulesOnlyDefault)
  const scalar = Object.keys(query).filter((key) => !['sort', 'nearLat', 'nearLng', 'nearRadius'].includes(key)).length
  return scalar + (filters.nearLat != null && filters.nearLng != null ? 1 : 0)
}

/** The fresh alert batch has no geo-metric/OSM context.  These must be
 * rejected when saved rather than silently ignored during notification. */
export function unsupportedAlertFilterKeys(filters: AuctionSearchFilters): string[] {
  return ALERT_UNSUPPORTED_FILTER_KEYS.filter((key) => {
    const value = filters[key]
    return typeof value === 'number' ? value > 0 : typeof value === 'string' && value !== ALL_SCOPE
  })
}
