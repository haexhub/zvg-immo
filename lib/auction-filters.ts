// Extracted from pages/index.vue's applyFilters()/scopeByCountryRegion()/
// auctionKategorie() (previously closures over ~12 reactive refs) so the
// filtering logic is a pure, testable function that both the client
// (pages/index.vue) and — starting Phase 3 — a server-side alert matcher can
// share without duplicating the rules.

import type { Auction } from '~/types/auction'
import { ALL_KATEGORIEN, classifyObjekt, type ObjektKategorie } from '~/lib/objektart'

export interface AuctionFilters {
  /** ISO country codes to restrict to; empty = no restriction (every country). */
  countries: string[]
  /** `${countryCode}:${regionDisplayName}` pairs to restrict to; null = no
   *  restriction. Matches against `${a.country}:${a.region}` — callers resolve
   *  the selected `${countryCode}:${regionCode}` keys to display names via the
   *  regions catalog (this module has no knowledge of that catalog). */
  regionNameKeys: Set<string> | null
  /** Free-text search; matched case-insensitively against Aktenzeichen,
   *  Amtsgericht, Objekt, Adresse and Beschreibung. Empty = no restriction. */
  search: string
  /** Amtsgericht name, or 'all'. */
  court: string
  /** Objektart id (see lib/objektart.ts), or 'all'. */
  kategorie: string
  onlyWithPhotos: boolean
  includeAufgehoben: boolean
  priceMin: number | null
  priceMax: number | null
  landMin: number | null
  landMax: number | null
  livMin: number | null
  livMax: number | null
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
// every crawled language) over classifyObjekt(a.objekt), which only matches
// German keywords — falling back to it only when extraction found nothing.
const KATEGORIE_LABEL = new Map(ALL_KATEGORIEN.map((k) => [k.id, k.label]))
export function auctionKategorie(a: Auction): ObjektKategorie {
  const pt = a.extraction?.propertyType
  if (pt) return { id: pt, label: KATEGORIE_LABEL.get(pt) ?? pt }
  return classifyObjekt(a.objekt)
}

export function filterAuctions<T extends Auction>(items: T[], filters: AuctionFilters): T[] {
  const q = filters.search.trim().toLowerCase()
  return scopeByCountryRegion(items, filters.countries, filters.regionNameKeys).filter((a) => {
    if (!filters.includeAufgehoben && a.aufgehoben) return false
    if (filters.court !== 'all' && a.amtsgericht !== filters.court) return false
    if (filters.kategorie !== 'all' && auctionKategorie(a).id !== filters.kategorie) return false
    if (filters.onlyWithPhotos && a.fotoCount === 0) return false
    if (filters.priceMin != null && (a.verkehrswertEur == null || a.verkehrswertEur < filters.priceMin)) return false
    if (filters.priceMax != null && (a.verkehrswertEur == null || a.verkehrswertEur > filters.priceMax)) return false
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
    if (!q) return true
    const hay = `${a.aktenzeichen} ${a.amtsgericht} ${a.objekt ?? ''} ${a.adresse ?? ''} ${a.beschreibung ?? ''}`.toLowerCase()
    return hay.includes(q)
  })
}
