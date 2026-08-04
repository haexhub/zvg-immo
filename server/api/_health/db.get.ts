// Invalid-index guard (docs/plans/2026-08-04-gis-wp1-index-notfall.md). A
// `CREATE INDEX CONCURRENTLY` that fails partway leaves an index that is
// silently ignored by the planner but still maintained on every write — that
// exact drift on `osm_local_elements` (idx_osm_local_elements_geog and
// idx_osm_local_elements_tag_place) turned a 560ms environment-filter query
// into a 16.6s Seq Scan over 20 GB. `indisvalid` alone would not have caught
// `aeroway`, though: that index never existed at all, same effect, nothing to
// flag as "invalid". So this checks both: any invalid index anywhere in the
// database, and a named list of indexes the environment/proximity filters
// (server/utils/auction-search-filters.ts, server/utils/osm-proximity.ts)
// depend on that must exist and be valid.
//
// Example:
//   curl http://localhost:3000/api/_health/db

import { getPool } from '~/server/utils/db'

// Every tag key used by PROXIMITY_FILTERS in auction-search-filters.ts,
// mapped to the `idx_osm_local_elements_tag_*` index it relies on to keep
// the OR-chain's BitmapOr plan (a single branch without a usable index
// forces the *entire* chain back to a Seq Scan — see the plan doc). Plus the
// `::geography` GIST index every proximity EXISTS/ST_DWithin subquery casts
// against (osm-proximity.ts) — not idx_osm_local_elements_geom, which the
// current queries never touch.
const EXPECTED_OSM_LOCAL_ELEMENTS_INDEXES = [
  'idx_osm_local_elements_tag_natural',
  'idx_osm_local_elements_tag_waterway',
  'idx_osm_local_elements_tag_water',
  'idx_osm_local_elements_tag_place',
  'idx_osm_local_elements_tag_aeroway',
  'idx_osm_local_elements_geog',
  'idx_osm_local_elements_geom',
]

interface IndexRow {
  index_name: string
}

export default defineEventHandler(async () => {
  const now = Date.now()
  const base = { serverTime: new Date(now).toISOString() }
  const db = getPool()
  if (!db) {
    return { ...base, ok: true, checked: false, reason: 'no databaseUrl configured' }
  }

  try {
    const [invalidResult, existingResult] = await Promise.all([
      db.query<IndexRow>(`SELECT indexrelid::regclass::text AS index_name FROM pg_index WHERE NOT indisvalid`),
      db.query<IndexRow>(
        `SELECT indexname AS index_name FROM pg_indexes WHERE tablename = 'osm_local_elements'`,
      ),
    ])
    const invalidIndexes = invalidResult.rows.map((row) => row.index_name)
    const existingNames = new Set(existingResult.rows.map((row) => row.index_name))
    const missingIndexes = EXPECTED_OSM_LOCAL_ELEMENTS_INDEXES.filter((name) => !existingNames.has(name))

    return {
      ...base,
      ok: invalidIndexes.length === 0 && missingIndexes.length === 0,
      checked: true,
      // Any invalid index in the whole database, not just the expected list
      // below — a future drift elsewhere should surface too.
      invalidIndexes,
      // Expected osm_local_elements indexes that do not exist at all (same
      // effect as invalid: the planner falls back to a Seq Scan).
      missingIndexes,
    }
  } catch (err) {
    // Same rationale as boe.get.ts: this endpoint's job is to surface
    // problems, so a failed catalog query shouldn't itself 500 — that would
    // hide behind a generic error instead of reporting what broke.
    return { ...base, ok: false, checked: false, error: (err as Error).message }
  }
})
