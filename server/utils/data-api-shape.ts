// The stable, documented JSON contract for /api/data/v1/* (the self-service
// Daten-API). Deliberately NOT a passthrough of the internal `Auction`/
// observation-row shapes (types/auction.ts, server/utils/history.ts), which
// stay free to change for internal reasons (new crawler fields, renamed
// columns, ...). External API consumers pin against `PublicAuction`/
// `PublicObservation`; adding a field here is backward compatible, renaming
// or removing one is a breaking change that belongs in a versioned
// /api/data/v2/* instead of mutating v1.

import type { Auction } from '~/types/auction'

export interface PublicAuction {
  /** Crawler/platform id, e.g. 'de-by', 'es-boe', 'agi'. */
  platform: string
  /** ISO 3166-1 alpha-2 country code, lowercase. */
  country: string
  /** Human-readable region/state name; empty string if the platform has none. */
  region: string
  /** Stable per-platform identifier (called `zvgId` internally). */
  id: string
  /** Court/authority running the auction (Amtsgericht or equivalent). */
  court: string
  /** Case/file number (Aktenzeichen or equivalent). */
  caseNumber: string
  title: string | null
  address: string | null
  marketValueEur: number | null
  /** ISO 8601 auction date/time, or null if unknown. */
  auctionDate: string | null
  /** True if the auction has been withdrawn/cancelled (aufgehoben). */
  withdrawn: boolean
  propertyType: string | null
  landAreaSqm: number | null
  livingAreaSqm: number | null
  rooms: number | null
  units: number | null
  photoCount: number
  /** ISO 8601 timestamp of the last crawl update, or null. */
  lastUpdated: string | null
  /** Relative path to this auction's page on the zvg-immo site. */
  appUrl: string
}

export function toPublicAuction(a: Auction): PublicAuction {
  return {
    platform: a.platform,
    country: a.country,
    region: a.region,
    id: a.zvgId,
    court: a.amtsgericht,
    caseNumber: a.aktenzeichen,
    title: a.objekt,
    address: a.adresse,
    marketValueEur: a.verkehrswertEur,
    auctionDate: a.terminIso,
    withdrawn: a.aufgehoben,
    propertyType: a.extraction?.propertyType ?? null,
    landAreaSqm: a.extraction?.landAreaSqm ?? null,
    livingAreaSqm: a.extraction?.livingAreaSqm ?? null,
    rooms: a.extraction?.rooms ?? null,
    units: a.extraction?.units ?? null,
    photoCount: a.fotoCount,
    lastUpdated: a.letzteAktualisierungIso,
    appUrl: `/objekt/${encodeURIComponent(a.platform)}/${encodeURIComponent(a.zvgId)}`,
  }
}

export interface PublicObservation {
  platform: string
  country: string
  region: string
  id: string
  court: string
  caseNumber: string
  title: string | null
  propertyType: string | null
  landAreaSqm: number | null
  livingAreaSqm: number | null
  rooms: number | null
  units: number | null
  marketValueEur: number | null
  auctionDate: string | null
  withdrawn: boolean
  /** ISO 8601 timestamp this row was captured at (one row per auction per
   *  refresh run — see server/utils/history.ts). */
  capturedAt: string
}

/** Row shape as returned by `pg` for a `SELECT * FROM auction_observations`
 *  query — `numeric` columns come back as strings (pg's default, to avoid
 *  float precision loss), hence the `Number(...)` coercions below. */
export function toPublicObservation(row: Record<string, unknown>): PublicObservation {
  const num = (v: unknown): number | null => (v == null ? null : Number(v))
  const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString())
  return {
    platform: row.platform as string,
    country: row.country as string,
    region: row.region as string,
    id: row.zvg_id as string,
    court: row.amtsgericht as string,
    caseNumber: row.aktenzeichen as string,
    title: (row.objekt as string | null) ?? null,
    propertyType: (row.property_type as string | null) ?? null,
    landAreaSqm: num(row.land_area_sqm),
    livingAreaSqm: num(row.living_area_sqm),
    rooms: num(row.rooms),
    units: num(row.units),
    marketValueEur: num(row.verkehrswert_eur),
    auctionDate: iso(row.termin_iso),
    withdrawn: row.aufgehoben as boolean,
    capturedAt: iso(row.captured_at) as string,
  }
}
