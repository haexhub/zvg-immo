// GIS WP-4 (docs/plans/2026-08-04-gis-wp4-geo-features.md): normalizes
// osm_local_elements (44.5M raw OSM rows, ~90% building, EPSG:4326, tags as
// jsonb) into geo_features — one row per (kind, geometry piece), reprojected
// to EPSG:3035 and pre-split with ST_Subdivide so a KNN query against WP-5's
// nightly precompute job can use the GIST index instead of scanning whole
// coastlines. `kind` replaces the OR-chain tag matching done live today
// (osm-proximity.ts) with a value computed once here.
//
// Idempotent via features_epoch: a full rebuild writes under a new epoch
// (max(features_epoch)+1) and only deletes the previous epoch's rows after
// every kind has finished. A crash mid-build leaves the old epoch fully
// intact for a live search to keep reading — nothing is ever deleted before
// the new build is known-complete, and a second run of this task is always
// safe (re-running never doubles a kind, since ST_Subdivide would otherwise
// split the same way twice under the same epoch).
//
// Own connection pool, hard-capped at BUILD_POOL_MAX_CONNECTIONS and
// separate from the app's shared request-serving pool (server/utils/db.ts):
// this job scans the same 20GB osm_local_elements table whose connection
// exhaustion took prod down on 2026-08-03 (the ansible OSM reimport job).
// Meant to run off-peak, triggered manually or via cron — never on the
// request path.
import { Pool, type PoolClient } from 'pg'
import { readDatabaseUrl } from '../utils/db'
import { runExclusiveTask, throwIfTaskAborted } from '../utils/exclusive-task'

const BUILD_POOL_MAX_CONNECTIONS = 2
// Batch job, no latency requirement — generous per-statement ceiling so a
// large kind (e.g. sea/coastline across every imported country) has room to
// finish, while still bounding a genuinely stuck query instead of holding a
// connection (and a lock on the destination rows) forever.
const BUILD_STATEMENT_TIMEOUT_MS = 20 * 60 * 1000

interface KindMapping {
  kind: string
  /** SQL boolean expression over `osm_local_elements o`, ANDed/ORed as documented. */
  where: string
}

// docs/plans/2026-08-04-gis-wp4-geo-features.md's kind-mapping table, applied
// verbatim. `ski_area` through `tourism_supply` reference OSM tags that
// osm_local_elements does not import yet (the Lua filter is multipolygon-only
// and never wrote landuse/leisure/route/tourism/historic tags for anything
// but the existing five kinds below) — see WP-6. The mapping is defined in
// full anyway, on purpose: those kinds simply build empty until the reimport
// lands, instead of this file needing a second pass later.
const KIND_MAPPINGS: KindMapping[] = [
  {
    kind: 'sea',
    where: `(o.tags ->> 'natural' IN ('coastline', 'beach', 'bay', 'strait')
      OR o.tags ->> 'water' IN ('sea', 'lagoon')
      OR o.tags ->> 'place' IN ('sea', 'ocean'))`,
  },
  {
    // Excludes river/stream/canal/ditch water polygons: natural=water alone
    // also covers river surface area, which would otherwise show up as a
    // false "lake nearby" (the pitfall the WP-4 doc calls out explicitly).
    kind: 'lake',
    where: `(o.tags ->> 'natural' = 'water'
      AND COALESCE(o.tags ->> 'water', '') NOT IN ('river', 'stream', 'canal', 'ditch'))`,
  },
  {
    kind: 'river',
    where: `(o.tags ->> 'waterway' IN ('river', 'canal'))`,
  },
  {
    kind: 'peak',
    where: `(o.tags ->> 'natural' = 'peak')`,
  },
  {
    kind: 'airport',
    where: `(o.tags ->> 'aeroway' = 'aerodrome')`,
  },
  {
    // Not importable yet (WP-6): landuse=winter_sports / piste:type /
    // aerialway aren't in osm_local_elements today.
    kind: 'ski_area',
    where: `(o.tags ->> 'landuse' = 'winter_sports'
      OR o.tags ? 'piste:type'
      OR o.tags ->> 'aerialway' IN ('gondola', 'chair_lift', 'cable_car', 'drag_lift'))`,
  },
  {
    kind: 'swimming',
    where: `(o.tags ->> 'leisure' = 'swimming_area'
      OR o.tags ->> 'sport' = 'swimming'
      OR o.tags ->> 'natural' = 'beach'
      OR o.tags ->> 'amenity' IN ('public_bath', 'spa'))`,
  },
  {
    kind: 'marina',
    where: `(o.tags ->> 'leisure' IN ('marina', 'slipway'))`,
  },
  {
    // Not importable yet (WP-6): route relations are dropped entirely by
    // today's Lua filter (multipolygon-only, see the architecture doc).
    kind: 'hiking_route',
    where: `(o.tags ->> 'route' = 'hiking' OR o.tags ? 'sac_scale')`,
  },
  {
    // Not importable yet (WP-6).
    kind: 'mtb_route',
    where: `(o.tags ->> 'route' = 'mtb'
      OR o.tags ->> 'mtb' IN ('yes', 'designated')
      OR o.tags ? 'mtb:scale')`,
  },
  {
    // Not importable yet (WP-6).
    kind: 'paddling',
    where: `(o.tags ->> 'canoe' IN ('yes', 'designated') OR o.tags ? 'whitewater')`,
  },
  {
    kind: 'fishing',
    where: `(o.tags ->> 'leisure' = 'fishing'
      OR o.tags ->> 'sport' = 'fishing'
      OR o.tags ->> 'fishing' = 'yes')`,
  },
  {
    // Not importable yet (WP-6): tourism/historic tags beyond what's used by
    // `swimming`/`sea` above aren't in osm_local_elements today.
    kind: 'attraction',
    where: `(o.tags ->> 'tourism' IN ('attraction', 'museum', 'viewpoint', 'theme_park', 'zoo')
      OR o.tags ->> 'historic' IN ('castle', 'monument', 'memorial', 'archaeological_site', 'fort'))`,
  },
  {
    // Not importable yet (WP-6).
    kind: 'tourism_supply',
    where: `(o.tags ->> 'tourism' IN ('camp_site', 'caravan_site', 'hotel', 'guest_house', 'apartment', 'alpine_hut')
      OR o.tags ->> 'leisure' IN ('golf_course', 'water_park', 'nature_reserve'))`,
  },
]

// Transform before subdivide, not after (subdividing in 4326 first and then
// projecting introduces inaccuracies at segment boundaries — see the WP-4
// doc's pitfalls section). MakeValid guards against self-intersecting OSM
// polygons breaking ST_Subdivide. Points/multipoints skip both MakeValid and
// ST_Subdivide entirely: subdividing a point is a no-op that only costs time.
const GEOMETRY_PIECE_JOIN = `
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN GeometryType(o.geom) IN ('POINT', 'MULTIPOINT') THEN ARRAY[ST_Transform(o.geom, 3035)]
      ELSE (SELECT array_agg(piece) FROM ST_Subdivide(ST_Transform(ST_MakeValid(o.geom), 3035), 128) AS piece)
    END AS pieces
  ) _pieces
  CROSS JOIN LATERAL unnest(_pieces.pieces) AS geom_3035
`

export default defineTask({
  meta: {
    name: 'build-geo-features',
    description: 'Rebuild geo_features from osm_local_elements (GIS WP-4).',
  },
  async run(): Promise<{ result: BuildGeoFeaturesResult | { skipped: true } }> {
    return await runExclusiveTask('build-geo-features', runBuildGeoFeatures)
  },
})

async function runBuildGeoFeatures(signal: AbortSignal): Promise<{ result: BuildGeoFeaturesResult | { skipped: true } }> {
  const url = readDatabaseUrl()
  if (!url) {
    console.log('[build-geo-features] no NUXT_DATABASE_URL configured, skipping')
    return { result: { skipped: true as const } }
  }

  const pool = new Pool({
    connectionString: url,
    max: BUILD_POOL_MAX_CONNECTIONS,
    statement_timeout: BUILD_STATEMENT_TIMEOUT_MS,
  })
  try {
    const client = await pool.connect()
    try {
      return { result: await buildGeoFeatures(client, signal) }
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

export interface BuildGeoFeaturesResult {
  epoch: number
  perKind: Record<string, { inserted: number; skipped: number }>
  deletedStale: number
  durationMs: number
}

/**
 * Rebuilds every kind under a new features_epoch and, only once all of them
 * have committed successfully, deletes rows left over from older epochs.
 * Exported (rather than folded into runBuildGeoFeatures) so tests can drive
 * it directly against a real Postgres connection without going through
 * Nitro's task/runtime-config globals.
 */
export async function buildGeoFeatures(client: PoolClient, signal: AbortSignal): Promise<BuildGeoFeaturesResult> {
  const startedAt = Date.now()
  await acquireRebuildLock(client)
  try {
    const epoch = await nextFeaturesEpoch(client)
    console.log(`[build-geo-features] start, epoch=${epoch}`)

    const perKind: Record<string, { inserted: number; skipped: number }> = {}
    for (const mapping of KIND_MAPPINGS) {
      throwIfTaskAborted(signal)
      const kindStartedAt = Date.now()
      const outcome = await buildKind(client, mapping, epoch, signal)
      perKind[mapping.kind] = outcome
      console.log(
        `[build-geo-features] kind=${mapping.kind} inserted=${outcome.inserted} skipped=${outcome.skipped} `
        + `in ${((Date.now() - kindStartedAt) / 1000).toFixed(1)}s`,
      )
    }

    // Only reached once every kind above has committed without throwing — an
    // aborted or failed run leaves the previous epoch's rows untouched and in
    // service, and simply gets redone (under yet another new epoch) next time.
    throwIfTaskAborted(signal)
    const { rowCount: deletedStale } = await client.query('DELETE FROM geo_features WHERE features_epoch < $1', [epoch])
    await client.query('ANALYZE geo_features')
    // Only now is this epoch complete — readers (WP-5's auction_geo_metrics
    // precompute job) resolve the current epoch via this table, never via
    // MAX(features_epoch) on geo_features directly, so a rebuild in progress
    // is never mistaken for done (see schema/geo.ts's geoFeaturesEpochs
    // comment).
    await client.query('INSERT INTO geo_features_epochs (epoch) VALUES ($1) ON CONFLICT (epoch) DO NOTHING', [epoch])

    const durationMs = Date.now() - startedAt
    console.log(`[build-geo-features] done in ${(durationMs / 1000).toFixed(0)}s, deleted ${deletedStale ?? 0} stale rows`)

    return { epoch, perKind, deletedStale: deletedStale ?? 0, durationMs }
  } finally {
    await releaseRebuildLock(client)
  }
}

// runExclusiveTask only serialises runs inside one Node process. Two app
// containers (or a container plus a manually triggered ad-hoc run) would
// otherwise both read the same MAX(features_epoch) + 1, write under the same
// epoch, and then each delete everything below it — including the rows the
// other one just wrote. A session-level advisory lock makes the whole rebuild
// exclusive database-wide.
//
// Deliberately *not* one big transaction around the rebuild: per-kind implicit
// transactions are the point (see buildKind), and holding a single transaction
// open across a 44.5M-row scan would pin WAL and block autovacuum for hours.
const REBUILD_LOCK_KEY = 4_820_251_104

async function acquireRebuildLock(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [REBUILD_LOCK_KEY])
  if (!rows[0]?.locked) {
    throw new Error('[build-geo-features] another rebuild is already running (advisory lock held), skipping this run')
  }
}

async function releaseRebuildLock(client: PoolClient): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [REBUILD_LOCK_KEY])
  } catch (err) {
    // The lock dies with the session anyway, so a failed unlock (e.g. the
    // connection already broke) must not mask the original error.
    console.warn(`[build-geo-features] releasing advisory lock failed: ${(err as Error).message}`)
  }
}

async function nextFeaturesEpoch(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ next_epoch: number }>(
    'SELECT COALESCE(MAX(features_epoch), 0) + 1 AS next_epoch FROM geo_features',
  )
  return rows[0]?.next_epoch ?? 1
}

// One INSERT ... SELECT per kind (committed as its own implicit transaction,
// not batched into a shared one) so a failure in kind 14 never rolls back the
// 13 before it, and a stuck kind never holds a lock for the whole run.
async function buildKind(
  client: PoolClient,
  mapping: KindMapping,
  epoch: number,
  signal: AbortSignal,
): Promise<{ inserted: number; skipped: number }> {
  throwIfTaskAborted(signal)
  const sql = `
    INSERT INTO geo_features (kind, name, country, osm_type, osm_id, geom_3035, features_epoch)
    SELECT $1, o.tags ->> 'name', o.country, o.osm_type, o.osm_id, geom_3035, $2
    FROM osm_local_elements o
    ${GEOMETRY_PIECE_JOIN}
    WHERE ${mapping.where}
  `
  try {
    const res = await client.query(sql, [mapping.kind, epoch])
    return { inserted: res.rowCount ?? 0, skipped: 0 }
  } catch (err) {
    // A single OSM element whose geometry ST_MakeValid/ST_Transform/
    // ST_Subdivide can't process (e.g. a self-intersecting ring GEOS can't
    // reconcile, or an out-of-range coordinate) fails the whole set-based
    // INSERT. Falling back to a per-row pass isolates that one element
    // instead of losing the entire kind — see the WP-4 doc's "ungültige
    // Geometrien" pitfall: silently dropping a broken kind wholesale is
    // worse than a kind missing a handful of rows, but it must be logged,
    // not swallowed.
    //
    // Only for row-local failures, though: a systemic one (missing column,
    // no permission, statement timeout, disk full) fails every row too, and
    // the per-row pass would then report the whole kind as "skipped" —
    // a successful-looking rebuild that goes on to delete the previous
    // epoch's still-good rows.
    if (isSystemicDatabaseError(err)) throw err
    console.warn(
      `[build-geo-features] kind=${mapping.kind} bulk insert failed (${(err as Error).message}), retrying row by row`,
    )
    return await buildKindPerRow(client, mapping, epoch, signal, err)
  }
}

// SQLSTATE classes that can never be caused by one bad geometry:
// 08 connection, 28 invalid authorization, 2B/2D/40 transaction state,
// 42 syntax/access rule (missing table/column, no permission),
// 53 insufficient resources, 54 program limit, 57 operator intervention
// (incl. 57014 statement_timeout), 58 external system error.
const SYSTEMIC_SQLSTATE_CLASSES = ['08', '28', '2B', '2D', '40', '42', '53', '54', '57', '58']

export function isSystemicDatabaseError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && SYSTEMIC_SQLSTATE_CLASSES.includes(code.slice(0, 2))
}

async function buildKindPerRow(
  client: PoolClient,
  mapping: KindMapping,
  epoch: number,
  signal: AbortSignal,
  bulkError: unknown,
): Promise<{ inserted: number; skipped: number }> {
  // country is part of osm_local_elements' identity (see schema/geo.ts): a
  // border feature can have one row per country, so a candidate must carry
  // its own country through to rowSql — filtering by osm_type/osm_id alone
  // would match every country's row for a shared element and insert it once
  // per candidate per matching row instead of once per row.
  const { rows: candidates } = await client.query<{ osm_type: string; osm_id: number; country: string }>(
    `SELECT o.osm_type, o.osm_id, o.country FROM osm_local_elements o WHERE ${mapping.where}`,
  )

  const rowSql = `
    INSERT INTO geo_features (kind, name, country, osm_type, osm_id, geom_3035, features_epoch)
    SELECT $1, o.tags ->> 'name', o.country, o.osm_type, o.osm_id, geom_3035, $2
    FROM osm_local_elements o
    ${GEOMETRY_PIECE_JOIN}
    WHERE o.osm_type = $3 AND o.osm_id = $4 AND o.country = $5
  `

  let inserted = 0
  let skipped = 0
  for (const { osm_type, osm_id, country } of candidates) {
    throwIfTaskAborted(signal)
    try {
      const res = await client.query(rowSql, [mapping.kind, epoch, osm_type, osm_id, country])
      inserted += res.rowCount ?? 0
    } catch (err) {
      if (isSystemicDatabaseError(err)) throw err
      skipped++
      console.warn(`[build-geo-features] kind=${mapping.kind} skipped ${osm_type}/${osm_id}/${country}: ${(err as Error).message}`)
    }
  }
  // Every single candidate failing is not "a handful of broken geometries" —
  // it's the bulk error having been systemic after all, under a SQLSTATE the
  // classification above doesn't cover. Surface it instead of reporting an
  // empty kind as a successful rebuild.
  if (inserted === 0 && skipped === candidates.length && candidates.length > 0) throw bulkError
  return { inserted, skipped }
}
