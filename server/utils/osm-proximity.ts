// Shared "is this auction within X meters of a tagged OSM element" fragment,
// built against the osm_local_elements PostGIS table (PR #282, ansible-side
// osm2pgsql import). Used both by the landing page's fixed-radius geo rails
// (server/api/landing/rails.get.ts) and the search endpoints' user-adjustable
// Umgebung filters (auction-search-filters.ts) — one place instead of two
// copies of the same EXISTS/ST_DWithin fragment.
//
// A country whose OSM import hasn't loaded the relevant tag yet (see PR #282's
// follow-up on ansible) simply matches nothing here — callers should treat
// that as "no results for this filter", not an error.
export function proximityCondition(
  tagKey: string,
  tagValue: string,
  radiusMeters: number,
  add: (value: unknown) => string,
): string {
  return `a.lat IS NOT NULL AND a.lng IS NOT NULL AND EXISTS (
    SELECT 1 FROM osm_local_elements o
    WHERE o.country = a.country
      AND o.tags ->> ${add(tagKey)} = ${add(tagValue)}
      AND ST_DWithin(o.geom::geography, ST_MakePoint(a.lng, a.lat)::geography, ${add(radiusMeters)})
  )`
}

/** Same as proximityCondition, but matches any of several tag values (e.g. place IN city/town). */
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
