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
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { isStatementTimeoutError, pgErrorMessage, readDatabaseUrl } from '../utils/db'
import { runExclusiveTask, throwIfTaskAborted } from '../utils/exclusive-task'
import { GEO_METRIC_CATEGORIES, type GeoMetricCategory } from '../utils/geo-metric-categories'
import { isSystemicDatabaseError } from './build-geo-features'

const BUILD_POOL_MAX_CONNECTIONS = 2
// A KNN scan against a sparsely-populated kind/epoch combination can
// legitimately take longer than a typical candidate's few milliseconds.
// Generous headroom over that now that a single slow candidate is skipped
// rather than aborting the whole run (see the statement_timeout handling
// below) — still far short of build-geo-features.ts's 20 minutes, which
// covers a fundamentally heavier bulk workload.
const BUILD_STATEMENT_TIMEOUT_MS = 3 * 60 * 1000

// Density, not distance — measures whether an area has tourist
// infrastructure at all (schema/geo.ts's tourismDensityCount comment).
// 'tourism_supply' is still empty pending WP-6's OSM tag import, so this
// counts zero for every auction today; that's expected, not a bug.
const TOURISM_DENSITY_KIND = 'tourism_supply'
const TOURISM_DENSITY_RADIUS_METERS = 10_000

// Sights rather than lodging/leisure supply (schema/geo.ts's
// attractionDensityCount comment) — WP-8's own example uses a wider radius
// here (30km) than tourism_supply's 10km, since a sight is worth visiting
// from farther away than a hotel is worth staying at.
const ATTRACTION_DENSITY_KIND = 'attraction'
const ATTRACTION_DENSITY_RADIUS_METERS = 30_000

// Distance, not density, unlike the two counts above — WP-8's example shows
// this as "Wanderwegnetz angrenzend", i.e. a proximity fact, not a count.
// Deliberately kept out of GEO_METRIC_CATEGORIES/geo-metric-categories.ts:
// that list is the shared writer/reader contract for search-filter sliders
// (auction-search-filters.ts iterates it to build `?near*=` params), and this
// column has no such filter — it's WP-8 detail-page-only, computed here as
// its own one-off nearest-feature query instead.
const HIKING_KIND = 'hiking_route'
const HIKING_CUTOFF_METERS = 20_000

// Unlike the live osm-proximity.ts queries this replaces, this does not
// constrain the geo_features row to the auction's own country. That
// constraint existed there mainly to let a country-prefixed index narrow an
// otherwise-unbounded live scan (schema/geo.ts's idx_osm_local_elements_
// country_* comment) — a performance artifact, not a business rule. A lake
// or peak just across a border is still physically near the auction, and
// 'sea' was already exempted from it live for the same reason. Distances
// here are exact measurements against real geometry, so there is no reason
// to keep an approximation's compromise.
//
// features_epoch is pinned to the snapshot resolved at the start of this run
// (not just "whatever the epoch number is called"): build-geo-features.ts
// commits a rebuild per-kind and only deletes the previous epoch's rows at
// the very end, so geo_features can transiently hold both epochs' rows
// mid-rebuild. Without this filter, a KNN match here could silently pick up
// a same-kind row from the *other* epoch if it happened to be nearer.
function categorySelectSql(category: GeoMetricCategory, epoch: number): string {
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
      return { result: await buildAuctionGeoMetrics(drizzle(client), signal) }
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
  /** A newer complete epoch landed mid-run; the rest was left for next time. */
  epochSuperseded: boolean
  /** Rows removed because their auction no longer has a lat/lng — see deleteOrphanedMetrics. */
  orphaned: number
  durationMs: number
}

interface Candidate {
  [key: string]: unknown
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
  db: NodePgDatabase,
  signal: AbortSignal,
): Promise<BuildAuctionGeoMetricsResult | { skipped: true; reason: string }> {
  const startedAt = Date.now()
  await acquireLock(db)
  try {
    const orphaned = await deleteOrphanedMetrics(db)
    if (orphaned > 0) {
      console.log(`[build-auction-geo-metrics] removed ${orphaned} metrics row(s) for auctions that lost their geocode`)
    }

    const epoch = await latestCompleteEpoch(db)
    if (epoch == null) {
      const reason = 'no complete geo_features epoch yet (geo_features_epochs is empty)'
      console.log(`[build-auction-geo-metrics] skipping: ${reason}`)
      return { skipped: true, reason }
    }

    throwIfTaskAborted(signal)
    const candidates = await findCandidates(db, epoch)
    console.log(`[build-auction-geo-metrics] start, epoch=${epoch}, candidates=${candidates.length}`)

    let computed = 0
    let skipped = 0
    let epochSuperseded = false
    for (const candidate of candidates) {
      throwIfTaskAborted(signal)
      try {
        if (!await upsertMetrics(db, candidate, epoch)) {
          // A rebuild completed while this run was working: geo_features no
          // longer holds `epoch`'s rows, so every further measurement against
          // it would come back NULL. Stop instead of persisting those — the
          // rows already written stay correct, and the next run picks up
          // everything still tagged with the old epoch as a candidate again.
          epochSuperseded = true
          break
        }
        computed++
      } catch (err) {
        // Unlike build-geo-features.ts's bulk-insert-with-per-row-fallback —
        // where a 57xxx there could mean the whole bulk statement failed, not
        // just one geometry — every candidate here is already its own
        // isolated UPSERT. A statement_timeout just means this one
        // candidate's KNN scan (e.g. against the 700k-row `lake` kind) took
        // too long; it says nothing about the rest, so skip it and keep
        // going instead of aborting the entire run and leaving every other
        // candidate — including ones stale for days — unrecomputed.
        if (isSystemicDatabaseError(err) && !isStatementTimeoutError(err)) throw err
        skipped++
        console.warn(
          `[build-auction-geo-metrics] skipped ${candidate.platform}/${candidate.external_id}: ${pgErrorMessage(err)}`,
        )
      }
    }

    const durationMs = Date.now() - startedAt
    if (epochSuperseded) {
      console.warn(
        `[build-auction-geo-metrics] stopping early: geo_features epoch ${epoch} was superseded mid-run, `
        + `${candidates.length - computed - skipped} candidates deferred to the next run`,
      )
    }
    console.log(`[build-auction-geo-metrics] done in ${(durationMs / 1000).toFixed(1)}s, computed=${computed} skipped=${skipped}`)
    return { epoch, candidates: candidates.length, computed, skipped, epochSuperseded, orphaned, durationMs }
  } finally {
    await releaseLock(db)
  }
}

// Distinct from build-geo-features.ts's REBUILD_LOCK_KEY (4_820_251_104) —
// the two jobs read/write disjoint tables and must be able to run
// concurrently; this only serializes two instances of this job against each
// other (see build-geo-features.ts's own comment for why runExclusiveTask's
// in-process-only serialization isn't enough across containers).
const METRICS_LOCK_KEY = 4_820_251_205

async function acquireLock(db: NodePgDatabase): Promise<void> {
  const { rows } = await db.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_lock(${METRICS_LOCK_KEY}) AS locked`)
  if (!rows[0]?.locked) {
    throw new Error('[build-auction-geo-metrics] another run is already in progress (advisory lock held), skipping this run')
  }
}

async function releaseLock(db: NodePgDatabase): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_advisory_unlock(${METRICS_LOCK_KEY})`)
  } catch (err) {
    console.warn(`[build-auction-geo-metrics] releasing advisory lock failed: ${(err as Error).message}`)
  }
}

async function latestCompleteEpoch(db: NodePgDatabase): Promise<number | null> {
  const { rows } = await db.execute<{ epoch: number | null }>(sql`SELECT MAX(epoch) AS epoch FROM geo_features_epochs`)
  return rows[0]?.epoch ?? null
}

// findCandidates below only ever (re)computes a row for an auction that
// currently has a lat/lng — an auction that loses its geocode (re-crawl reset,
// invalidated Nominatim/LocationIQ result) drops out of that query entirely,
// so without this its metrics row would sit forever with whatever distances
// its old, now-gone position happened to produce and keep matching proximity
// filters (nearSea, nearMountain, …) against a location the auction no longer
// claims to be at.
async function deleteOrphanedMetrics(db: NodePgDatabase): Promise<number> {
  const { rowCount } = await db.execute(sql`
    DELETE FROM auction_geo_metrics m
    WHERE NOT EXISTS (
      SELECT 1 FROM auctions a
      WHERE a.platform = m.platform AND a.external_id = m.external_id
        AND a.lat IS NOT NULL AND a.lng IS NOT NULL
    )
  `)
  return rowCount ?? 0
}

async function findCandidates(db: NodePgDatabase, epoch: number): Promise<Candidate[]> {
  const { rows } = await db.execute<Candidate>(sql`
    SELECT a.platform, a.external_id, a.lat, a.lng, md5(a.lat::text || ',' || a.lng::text) AS point_hash
    FROM auctions a
    LEFT JOIN auction_geo_metrics m ON m.platform = a.platform AND m.external_id = a.external_id
    WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL
      AND (
        m.platform IS NULL
        OR m.features_epoch IS DISTINCT FROM ${epoch}
        OR m.point_hash IS DISTINCT FROM md5(a.lat::text || ',' || a.lng::text)
      )
  `)
  return rows
}

/**
 * Writes one auction's metrics, or nothing at all if `epoch` is no longer the
 * newest complete one. Returns whether the row was written.
 *
 * The guard is what keeps a concurrent rebuild from corrupting this run:
 * build-geo-features.ts swaps epochs by deleting the old rows and inserting
 * the new epoch's marker in a single transaction, and Postgres evaluates this
 * whole statement against one snapshot (READ COMMITTED). So either the
 * snapshot predates the swap — `epoch` is still current and its geo_features
 * rows are all there — or it postdates it, the guard fails and nothing is
 * written. There is no in-between where the rows are gone but the epoch still
 * looks current, which would otherwise persist NULL distances for every
 * remaining candidate.
 */
async function upsertMetrics(db: NodePgDatabase, candidate: Candidate, epoch: number): Promise<boolean> {
  const distanceColumns = [...GEO_METRIC_CATEGORIES.map((c) => c.column), 'dist_hiking_m']
  const hikingSelectSql = categorySelectSql(
    { param: 'hiking', column: 'dist_hiking_m', kind: HIKING_KIND, cutoffMeters: HIKING_CUTOFF_METERS },
    epoch,
  )
  const query = sql`
    WITH point AS (
      SELECT ST_Transform(ST_SetSRID(ST_MakePoint(${candidate.lng}, ${candidate.lat}), 4326), 3035) AS geom
    )
    INSERT INTO auction_geo_metrics (
      platform, external_id, ${sql.raw(distanceColumns.join(', '))}, tourism_density_count, attraction_density_count, point_hash, features_epoch, computed_at
    )
    SELECT ${candidate.platform}, ${candidate.external_id},
      ${sql.raw(GEO_METRIC_CATEGORIES.map((c) => categorySelectSql(c, epoch)).join(',\n      '))},
      ${sql.raw(hikingSelectSql)},
      (SELECT count(*)::int FROM geo_features f, point
        WHERE f.kind = ${TOURISM_DENSITY_KIND} AND f.features_epoch = ${epoch}
          AND ST_DWithin(f.geom_3035, point.geom, ${TOURISM_DENSITY_RADIUS_METERS})),
      (SELECT count(*)::int FROM geo_features f, point
        WHERE f.kind = ${ATTRACTION_DENSITY_KIND} AND f.features_epoch = ${epoch}
          AND ST_DWithin(f.geom_3035, point.geom, ${ATTRACTION_DENSITY_RADIUS_METERS})),
      ${candidate.point_hash}, ${epoch}, now()
    FROM point
    WHERE (SELECT MAX(epoch) FROM geo_features_epochs) = ${epoch}
    ON CONFLICT (platform, external_id) DO UPDATE SET
      ${sql.raw(distanceColumns.map((c) => `${c} = EXCLUDED.${c}`).join(',\n      '))},
      tourism_density_count = EXCLUDED.tourism_density_count,
      attraction_density_count = EXCLUDED.attraction_density_count,
      point_hash = EXCLUDED.point_hash,
      features_epoch = EXCLUDED.features_epoch,
      computed_at = EXCLUDED.computed_at
  `
  const { rowCount } = await db.execute(query)
  return (rowCount ?? 0) > 0
}
