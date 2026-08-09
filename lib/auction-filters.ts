// Extracted from pages/index.vue's applyFilters()/scopeByCountryRegion()/
// auctionKategorie() (previously closures over ~12 reactive refs) so the
// filtering logic is a pure, testable function that both the client
// (pages/index.vue) and — starting Phase 3 — a server-side alert matcher can
// share without duplicating the rules.

import type { Auction, AuctionExtraction } from '~/types/auction'
import { ALL_PROPERTY_TYPE_CATEGORIES, classifyPropertyType, type PropertyTypeCategory } from '~/lib/property-type'
import { CONDITIONS } from '~/lib/condition'
import type { AuctionSearchFilters } from '~/lib/auction-search-filter-contract'

export interface AuctionFilters extends AuctionSearchFilters {
  /** `${countryCode}:${regionDisplayName}` pairs to restrict to; null = no
   *  restriction. Matches against `${a.country}:${a.region}` — callers resolve
   *  the selected `${countryCode}:${regionCode}` keys to display names via the
   *  regions catalog (this module has no knowledge of that catalog). */
  regionNameKeys: Set<string> | null
  /** Free-text search; matched case-insensitively against Aktenzeichen,
   *  Amtsgericht, Objekt, Adresse and Beschreibung. Empty = no restriction. */
}

/** Restricts to the selected countries/regions only. Used both as the base
 *  for the full filterAuctions() pass and for deriving the court/Objektart
 *  filter options, which must reflect only the selected countries/regions,
 *  not everything that happened to be fetched. */
export function scopeByCountryRegion<T extends Auction>(
  items: T[],
  countries: string[],
  regionNameKeys: Set<string> | null,
): T[] {
  const countrySet = countries.length ? new Set(countries) : null
  if (!countrySet && !regionNameKeys) return items
  return items.filter((a) => {
    if (countrySet && !countrySet.has(a.country)) return false
    if (regionNameKeys && !regionNameKeys.has(`${a.country}:${a.region}`)) return false
    return true
  })
}

// Prefer the extraction pipeline's propertyType (rules + LLM, understands
// every crawled language) over classifyPropertyType(a.title), which only
// matches German keywords — falling back to it only when extraction found nothing.
const CATEGORY_LABEL = new Map(ALL_PROPERTY_TYPE_CATEGORIES.map((k) => [k.id, k.label]))
export function auctionCategory(a: Auction): PropertyTypeCategory {
  const pt = a.extraction?.propertyType
  if (pt) return { id: pt, label: CATEGORY_LABEL.get(pt) ?? pt }
  return classifyPropertyType(a.title)
}

const CONDITION_RANK = new Map<string, number>(CONDITIONS.map((c, i) => [c, i]))

export function hasCompletedLlmAnalysis(e: AuctionExtraction | null | undefined): boolean {
  if (!e) return false
  return !!e.llmAnalyzedAt ||
    e.source === 'llm' ||
    e.condition !== undefined ||
    e.features !== undefined ||
    e.bedrooms !== undefined ||
    e.bathrooms !== undefined ||
    e.floor !== undefined ||
    e.bathroomHasTub !== undefined ||
    e.bathroomHasShower !== undefined ||
    e.heating !== undefined ||
    e.yearBuilt !== undefined ||
    e.lastRenovationYear !== undefined ||
    e.renovationNotes !== undefined ||
    e.insights !== undefined ||
    e.planningNotes !== undefined ||
    e.documentSummary !== undefined ||
    e.marketValueEur !== undefined
}

export function filterAuctions<T extends Auction>(items: T[], filters: AuctionFilters): T[] {
  const q = filters.search.trim().toLowerCase()
  const minConditionRank = filters.condition !== 'all' ? CONDITION_RANK.get(filters.condition) : undefined
  return scopeByCountryRegion(items, filters.countries, filters.regionNameKeys).filter((a) => {
    if (!filters.includeCancelled && a.cancelled) return false
    if (filters.authority !== 'all' && a.authority !== filters.authority) return false
    if (filters.category !== 'all' && auctionCategory(a).id !== filters.category) return false
    if (minConditionRank != null) {
      const rank = a.extraction?.condition != null ? CONDITION_RANK.get(a.extraction.condition) : undefined
      if (rank == null || rank > minConditionRank) return false
    }
    if (filters.features.length > 0) {
      const have: string[] = a.extraction?.features ?? []
      if (!filters.features.some((f) => have.includes(f))) return false
    }
    if (filters.onlyWithPhotos && a.photoCount === 0) return false
    if (filters.hideRulesOnly && !hasCompletedLlmAnalysis(a.extraction)) return false
    if (filters.priceMin != null && (a.marketValueEur == null || a.marketValueEur < filters.priceMin)) return false
    if (filters.priceMax != null && (a.marketValueEur == null || a.marketValueEur > filters.priceMax)) return false
    if (filters.landMin != null || filters.landMax != null) {
      const v = a.extraction?.landAreaSqm ?? null
      if (v == null) return false
      if (filters.landMin != null && v < filters.landMin) return false
      if (filters.landMax != null && v > filters.landMax) return false
    }
    if (filters.livMin != null || filters.livMax != null) {
      const v = a.extraction?.livingAreaSqm ?? null
      if (v == null) return false
      if (filters.livMin != null && v < filters.livMin) return false
      if (filters.livMax != null && v > filters.livMax) return false
    }
    if (filters.yearBuiltMin != null || filters.yearBuiltMax != null) {
      const v = a.extraction?.yearBuilt ?? null
      if (v == null) return false
      if (filters.yearBuiltMin != null && v < filters.yearBuiltMin) return false
      if (filters.yearBuiltMax != null && v > filters.yearBuiltMax) return false
    }
    if (filters.renovationYearMin != null || filters.renovationYearMax != null) {
      const v = a.extraction?.lastRenovationYear ?? null
      if (v == null) return false
      if (filters.renovationYearMin != null && v < filters.renovationYearMin) return false
      if (filters.renovationYearMax != null && v > filters.renovationYearMax) return false
    }
    if (filters.nearLat != null && filters.nearLng != null && filters.nearRadius != null && filters.nearRadius > 0) {
      if (a.lat == null || a.lng == null || distanceKm(a.lat, a.lng, filters.nearLat, filters.nearLng) > filters.nearRadius) return false
    }
    if (!q) return true
    const hay = `${a.caseNumber} ${a.authority} ${a.title ?? ''} ${a.address ?? ''} ${a.description ?? ''}`.toLowerCase()
    return hay.includes(q)
  })
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radians = Math.PI / 180
  const dLat = (lat2 - lat1) * radians
  const dLng = (lng2 - lng1) * radians
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
