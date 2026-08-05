// GIS WP-5 (docs/plans/2026-08-04-gis-wp5-precompute-suche.md): precomputes
// one wide auction_geo_metrics row per geocoded auction from geo_features
// (WP-4) — nearest-feature distance per category, plus a tourism-density
// count. A search filter then becomes a plain numeric column comparison
// instead of a live ST_DWithin/EXISTS join against osm_local_elements.
//
// Reads the *complete* epoch via geo_features_epochs, never
// MAX(features_epoch) on geo_features directly — a rebuild in progress would
// otherwise look done while only partially written (see schema/geo.ts's
// geoFeaturesEpochs comment and build-geo-features.ts).
//
// Own connection pool, hard-capped and separate from the app's shared
// request-serving pool, same rationale as build-geo-features.ts.
import { Pool, type PoolClient } from 'pg'
import { readDatabaseUrl } from '../utils/db'
import { runExclusiveTask, throwIfTaskAborted } from '../utils/exclusive-task'
import { isSystemicDatabaseError } from './build-geo-features'

const BUILD_POOL_MAX_CONNECTIONS = 2
const BUILD_STATEMENT_TIMEOUT_MS = 60 * 1000

interface DistanceCategory {
  /** auction_geo_metrics column. */
  column: string
  /** geo_features.kind to search. */
  kind: string
  /**
   * Also the search UI's slider maximum for this category (WP-5 doc's
   * cutoff/NULL-semantics note): NULL means "nothing of this kind within the
   * cutoff", not "unknown" — a larger requested radius would silently
   * misread as "nothing nearby" instead of being rejected.
   */
  cutoffMeters: number
}

// Unlike the live osm-proximity.ts queries this replaces, none of these
// constrain the geo_features row to the auction's own country. That
// constraint existed there mainly to let a country-prefixed index narrow an
// otherwise-unbounded live scan (schema/geo.ts's idx_osm_local_elements_
// country_* comment) — a performance artifact, not a business rule. A lake
// or peak just across a border is still physically near the auction, and
// 'sea' was already exempted from it live for the same reason. Distances
// here are exact measurements against real geometry, so there is no reason
// to keep an approximation's compromise.
const DISTANCE_CATEGORIES: DistanceCategory[] = [
  { column: 'dist_sea_m', kind: 'sea', cutoffMeters: 200_000 },
  { column: 'dist_lake_m', kind: 'lake', cutoffMeters: 50_000 },
  { column: 'dist_river_m', kind: 'river', cutoffMeters: 50_000 },
  { column: 'dist_mountain_m', kind: 'peak', cutoffMeters: 50_000 },
  // Not one of the WP-5 doc's proposed tiers (Meer/Ski 200km, See/Fluss/Berg
  // 50km) — airports don't fit either group's reasoning. 100km stands in for
  // "within a regional airport's usual catchment", documented rather than
  // guessed silently.
  { column: 'dist_airport_m', kind: 'airport', cutoffMeters: 100_000 },
  { column: 'dist_ski_m', kind: 'ski_area', cutoffMeters: 200_000 },
]

// Density, not distance — measures whether an area has tourist
// infrastructure at all (schema/geo.ts's tourismDensityCount comment).
// 'tourism_supply' is still empty pending WP-6's OSM tag import, so this
// counts zero for every auction today; that's expected, not a bug.
const TOURISM_DENSITY_KIND = 'tourism_supply'
const TOURISM_DENSITY_RADIUS_METERS = 10_000

// features_epoch is pinned to the snapshot resolved at the start of this run
// (not just "whatever the epoch number is called"): build-geo-features.ts
// commits a rebuild per-kind and only deletes the previous epoch's rows at
// the very end, so geo_features can transiently hold both epochs' rows
// mid-rebuild. Without this filter, a KNN match here could silently pick up
// a same-kind row from the *other* epoch if it happened to be nearer.
function categorySelectSql(category: DistanceCategory, epoch: number): string {
  return `(SELECT ST_Distance(f.geom_3035, point.geom)::int
    FROM geo_features f
    WHERE f.kind = '${category.kind}' AND f.features_epoch = ${epoch}
      AND ST_DWithin(f.geom_3035, point.geom, ${category.cutoffMeters})
    ORDER BY f.geom_3035 <-> point.geom
    LIMIT 1) AS "${category.column}"`
}

export default defineTask({
  meta: {
    name: 'build-auction-geo-metrics',
    description: 'Precompute auction_geo_metrics from geo_features (GIS WP-5).',
  },
  async run(): Promise<{ result: BuildAuctionGeoMetricsResult | { skipped: true } }> {
    return await runExclusiveTask('build-auction-geo-metrics', runBuildAuctionGeoMetrics)
  },
})

async function runBuildAuctionGeoMetrics(signal: AbortSignal): Promise<{ result: BuildAuctionGeoMetricsResult | { skipped: true } }> {
  const url = readDatabaseUrl()
  if (!url) {
    console.log('[build-auction-geo-metrics] no NUXT_DATABASE_URL configured, skipping')
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
      return { result: await buildAuctionGeoMetrics(client, signal) }
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

export interface BuildAuctionGeoMetricsResult {
  epoch: number
  candidates: number
  computed: number
  skipped: number
  durationMs: number
}

interface Candidate {
  platform: string
  external_id: string
  lat: number
  lng: number
  point_hash: string
}

/**
 * Recomputes every auction whose metrics row is missing, stale (older
 * geo_features epoch), or invalidated by re-geocoding (point_hash mismatch).
 * Exported so tests can drive it directly against a real Postgres
 * connection, same rationale as build-geo-features.ts's buildGeoFeatures.
 */
export async function buildAuctionGeoMetrics(
  client: PoolClient,
  signal: AbortSignal,
): Promise<BuildAuctionGeoMetricsResult | { skipped: true; reason: string }> {
  const startedAt = Date.now()
  await acquireLock(client)
  try {
    const epoch = await latestCompleteEpoch(client)
    if (epoch == null) {
      const reason = 'no complete geo_features epoch yet (geo_features_epochs is empty)'
      console.log(`[build-auction-geo-metrics] skipping: ${reason}`)
      return { skipped: true, reason }
    }

    throwIfTaskAborted(signal)
    const candidates = await findCandidates(client, epoch)
    console.log(`[build-auction-geo-metrics] start, epoch=${epoch}, candidates=${candidates.length}`)

    let computed = 0
    let skipped = 0
    for (const candidate of candidates) {
      throwIfTaskAborted(signal)
      try {
        await upsertMetrics(client, candidate, epoch)
        computed++
      } catch (err) {
        if (isSystemicDatabaseError(err)) throw err
        skipped++
        console.warn(
          `[build-auction-geo-metrics] skipped ${candidate.platform}/${candidate.external_id}: ${(err as Error).message}`,
        )
      }
    }

    const durationMs = Date.now() - startedAt
    console.log(`[build-auction-geo-metrics] done in ${(durationMs / 1000).toFixed(1)}s, computed=${computed} skipped=${skipped}`)
    return { epoch, candidates: candidates.length, computed, skipped, durationMs }
  } finally {
    await releaseLock(client)
  }
}

// Distinct from build-geo-features.ts's REBUILD_LOCK_KEY (4_820_251_104) —
// the two jobs read/write disjoint tables and must be able to run
// concurrently; this only serializes two instances of this job against each
// other (see build-geo-features.ts's own comment for why runExclusiveTask's
// in-process-only serialization isn't enough across containers).
const METRICS_LOCK_KEY = 4_820_251_205

async function acquireLock(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [METRICS_LOCK_KEY])
  if (!rows[0]?.locked) {
    throw new Error('[build-auction-geo-metrics] another run is already in progress (advisory lock held), skipping this run')
  }
}

async function releaseLock(client: PoolClient): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [METRICS_LOCK_KEY])
  } catch (err) {
    console.warn(`[build-auction-geo-metrics] releasing advisory lock failed: ${(err as Error).message}`)
  }
}

async function latestCompleteEpoch(client: PoolClient): Promise<number | null> {
  const { rows } = await client.query<{ epoch: number | null }>('SELECT MAX(epoch) AS epoch FROM geo_features_epochs')
  return rows[0]?.epoch ?? null
}

async function findCandidates(client: PoolClient, epoch: number): Promise<Candidate[]> {
  const { rows } = await client.query<Candidate>(
    `SELECT a.platform, a.external_id, a.lat, a.lng, md5(a.lat::text || ',' || a.lng::text) AS point_hash
     FROM auctions a
     LEFT JOIN auction_geo_metrics m ON m.platform = a.platform AND m.external_id = a.external_id
     WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL
       AND (
         m.platform IS NULL
         OR m.features_epoch IS DISTINCT FROM $1
         OR m.point_hash IS DISTINCT FROM md5(a.lat::text || ',' || a.lng::text)
       )`,
    [epoch],
  )
  return rows
}

async function upsertMetrics(client: PoolClient, candidate: Candidate, epoch: number): Promise<void> {
  const distanceColumns = DISTANCE_CATEGORIES.map((c) => c.column)
  const sql = `
    WITH point AS (
      SELECT ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3035) AS geom
    )
    INSERT INTO auction_geo_metrics (
      platform, external_id, ${distanceColumns.join(', ')}, tourism_density_count, point_hash, features_epoch, computed_at
    )
    SELECT $3, $4,
      ${DISTANCE_CATEGORIES.map((c) => categorySelectSql(c, epoch)).join(',\n      ')},
      (SELECT count(*)::int FROM geo_features f, point
        WHERE f.kind = '${TOURISM_DENSITY_KIND}' AND f.features_epoch = ${epoch}
          AND ST_DWithin(f.geom_3035, point.geom, ${TOURISM_DENSITY_RADIUS_METERS})),
      $5, $6, now()
    FROM point
    ON CONFLICT (platform, external_id) DO UPDATE SET
      ${distanceColumns.map((c) => `${c} = EXCLUDED.${c}`).join(',\n      ')},
      tourism_density_count = EXCLUDED.tourism_density_count,
      point_hash = EXCLUDED.point_hash,
      features_epoch = EXCLUDED.features_epoch,
      computed_at = EXCLUDED.computed_at
  `
  await client.query(sql, [candidate.lng, candidate.lat, candidate.platform, candidate.external_id, candidate.point_hash, epoch])
}
