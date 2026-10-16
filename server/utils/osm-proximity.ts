// Shared "is this auction within X meters of a tagged OSM element" fragment,
// built against the osm_local_elements PostGIS table (PR #282, ansible-side
// osm2pgsql import).
//
// GIS WP-5 moved the sea/lake/river/mountain/airport/ski Umgebung filters and
// the landing page's geo rails off this live query onto auction_geo_metrics
// (precomputed distances, see build-auction-geo-metrics.ts) — this file's
// only remaining caller is the urbanRural filter in auction-search-filters.ts,
// left on the live path deliberately: an equivalent precomputed
// dist_city_m needs its own geo_features 'city'/place kind, which WP-4
// didn't model (its kind table is considered complete, see WP-4's plan doc
// status note) — a bigger, separate change than adding it here silently.
//
// A country whose OSM import hasn't loaded the relevant tag yet simply
// matches nothing here — callers should treat that as "no results for this
// filter", not an error.
//
// Assumes the caller's FROM is `auctions a` joined to the newest
// `auction_details` as `d` (LATEST_DETAILS_JOIN_SQL): coordinates and country
// are both identity, so both live on `a` (WP-0 moved lat/lng off the
// versioned `auction_details` — see docs/plans/2026-08-04-gis-wp0-schema-neuaufbau.md).

/** "Is this auction within X meters of an OSM element whose tagKey is one of tagValues" — e.g. place IN (city, town). */
export function proximityConditionAnyOf(
  tagKey: string,
  tagValues: string[],
  radiusMeters: number,
  add: (value: unknown) => string,
): string {
  return `a.lat IS NOT NULL AND a.lng IS NOT NULL AND EXISTS (
    SELECT 1 FROM osm_local_elements o
    WHERE o.country = a.country
      AND o.tags ->> ${add(tagKey)} = ANY(${add(tagValues)}::text[])
      AND ST_DWithin(o.geom::geography, ST_MakePoint(a.lng, a.lat)::geography, ${add(radiusMeters)})
  )`
}
