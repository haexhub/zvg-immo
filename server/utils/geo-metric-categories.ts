// The one definition of the precomputed proximity categories, shared by the
// writer (server/tasks/build-auction-geo-metrics.ts) and the reader
// (server/utils/auction-search-filters.ts).
//
// `cutoffMeters` is the part that must not drift between the two: anything
// farther away is stored as NULL, meaning "nothing of this kind within the
// cutoff" — not "unknown". A search asking for a larger radius would read that
// NULL as "nothing nearby" and silently drop the auction instead of matching
// it, so the reader clamps to the same value the writer measured against.

export interface GeoMetricCategory {
  /** Search query parameter (`?nearSea=5`, in km). */
  param: string
  /** auction_geo_metrics column holding the distance in metres. */
  column: string
  /** geo_features.kind the distance is measured against. */
  kind: string
  /** Beyond this the precompute stores NULL — also the search slider's max. */
  cutoffMeters: number
}

export const GEO_METRIC_CATEGORIES: GeoMetricCategory[] = [
  { param: 'nearSea', column: 'dist_sea_m', kind: 'sea', cutoffMeters: 200_000 },
  { param: 'nearLake', column: 'dist_lake_m', kind: 'lake', cutoffMeters: 50_000 },
  { param: 'nearRiver', column: 'dist_river_m', kind: 'river', cutoffMeters: 50_000 },
  { param: 'nearMountain', column: 'dist_mountain_m', kind: 'peak', cutoffMeters: 50_000 },
  // Not one of the WP-5 doc's proposed tiers (Meer/Ski 200km, See/Fluss/Berg
  // 50km) — airports don't fit either group's reasoning. 100km stands in for
  // "within a regional airport's usual catchment", documented rather than
  // guessed silently.
  { param: 'nearAirport', column: 'dist_airport_m', kind: 'airport', cutoffMeters: 100_000 },
  // ski_area is still empty pending WP-6's OSM tag import (same "define the
  // mapping now, stays empty until then" pattern as geo_features' own kind
  // table) — matches nothing today, not a bug.
  { param: 'nearSki', column: 'dist_ski_m', kind: 'ski_area', cutoffMeters: 200_000 },
]
