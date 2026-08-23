// GIS WP-4 (docs/plans/2026-08-04-gis-wp4-geo-features.md): normalizes
// osm_local_elements (44.5M raw OSM rows, ~90% building, EPSG:4326, tags as
// jsonb) into geo_features — one row per (kind, geometry piece), reprojected
// to EPSG:3035 and pre-split with ST_Subdivide so a KNN query against WP-5's
// nightly precompute job can use the GIST index instead of scanning whole
// coastlines. `kind` replaces the OR-chain tag matching done live today
// (osm-proximity.ts) with a value computed once here.
//
// Idempotent via features_epoch: a full rebuild writes under a new epoch
// (see nextFeaturesEpoch) and only deletes the previous epoch's rows after
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
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { pgErrorCode, pgErrorMessage, readDatabaseUrl } from '../utils/db'
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
    // "Am Meer" must not mean "am See": the Bodensee or Gardasee is a lake,
    // and only `lake` below may match it. Two earlier tags in this mapping
    // broke that, both because the OSM tag is not sea-specific:
    //   - `natural=beach` marks beach material (sand/shingle) along lakes and
    //     rivers as often as along the coast — Bavaria alone has hundreds
    //     (Isar, Donau, Alpine lakes), which made `sea` match almost
    //     everywhere in Germany. `swimming` below covers beaches on their own
    //     terms.
    //   - `natural=bay`/`strait` likewise describe a shape, not a water body:
    //     of Germany's 232 named bays nearly all are inland-lake bays
    //     (Chiemsee's "Feldwieser Bucht", Walchensee, Tegernsee's "Egerner
    //     Bucht", and the Bodensee arms "Überlinger See"/"Gnadensee"), with
    //     "Leybucht" about the only marine one. Dropping them loses no real
    //     coast, because `natural=coastline` encloses every marine bay and
    //     strait anyway — a house on the Leybucht or the Fehmarnsund is just
    //     as close to the coastline itself.
    //   - `water=lagoon` is the same story: it covers Baltic Bodden ("Oderhaff")
    //     but also inland ponds ("Allmeier Biotop", "Molenbecken"). The Bodden
    //     are coastline-enclosed too — an auction near Anklam still measures
    //     6.1km to the Peenestrom coastline without it.
    // What remains is sea-only by definition, and coastline is well mapped in
    // every imported country (SE 79.5k, DE 1.4k, BG 195 elements).
    kind: 'sea',
    where: `(o.tags ->> 'natural' = 'coastline'
      OR o.tags ->> 'water' = 'sea'
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
    // `natural=peak` alone matches any locally highest point OSM mappers
    // bothered to tag — including sub-100m mounds on the North German Plain
    // (e.g. a 20m rise near Hamburg), which made nearMountain match almost
    // everywhere in flat regions too. Real German/Alpine mountains are
    // reliably tagged with `ele`; a 300m floor keeps the Mittelgebirge and
    // Alps while dropping flatland "peaks" — `ele` is absolute elevation,
    // not topographic prominence (which OSM rarely tags), so this is an
    // approximation, not exact. A peak missing `ele` entirely is treated as
    // unqualified rather than assumed real.
    kind: 'peak',
    where: `(o.tags ->> 'natural' = 'peak'
      AND o.tags ->> 'ele' ~ '^-?[0-9]+(\\.[0-9]+)?$'
      AND (o.tags ->> 'ele')::numeric >= 300)`,
  },
  {
    // `aeroway=aerodrome` alone matches every mapped airfield, including
    // gliding and general-aviation strips — Germany has 742 of them, dense
    // enough that nearAirport barely excluded anything (an auction in Zwickau
    // counted as 2.9km from "Flugplatz Zwickau", an `aerodrome=airsport`
    // club strip). Requiring an `iata` code was the first narrowing, but 84
    // German aerodromes carry one, including island air taxi strips like
    // "Flugplatz Baltrum"/"Juist"/"Langeoog" and the military "Fliegerhorst
    // Jagel" — not what someone searching for an airport means.
    // `aerodrome`/`aerodrome:type` = international is OSM's own marker for
    // scheduled international traffic and yields exactly the 22 real German
    // airports (FRA, MUC, BER, DUS, HAM, STR, CGN, …). It is a stricter tag
    // and less universally applied than `iata` (SE 8, BG 3), so a few
    // genuinely international airports may be missed until mappers add it —
    // deliberately preferred over the false positives, since an unmatched
    // airport only narrows results while a club strip widens them to
    // everything.
    kind: 'airport',
    where: `(o.tags ->> 'aeroway' = 'aerodrome'
      AND (o.tags ->> 'aerodrome' = 'international'
        OR o.tags ->> 'aerodrome:type' = 'international'))`,
  },
  {
    // Feeds the WP-8 leisure-tourism profile's "any ski area nearby"
    // criterion (leisure-tourism-profile.ts), which deliberately doesn't
    // care which piste type — see ski_downhill/ski_nordic below for the
    // search filter's more specific split.
    kind: 'ski_area',
    where: `(o.tags ->> 'landuse' = 'winter_sports'
      OR o.tags ? 'piste:type'
      OR o.tags ->> 'aerialway' IN ('gondola', 'chair_lift', 'cable_car', 'drag_lift'))`,
  },
  {
    // "Bergabfahrt" means an explicitly mapped alpine ski run, not merely a
    // lift. Aerialway tags also cover sightseeing and local transport, and a
    // lift without a connected downhill piste is not evidence of a ski area.
    // Keeping that distinction is intentionally conservative: a missing
    // result is preferable to claiming that a flat city is near a downhill
    // ski resort. landuse=winter_sports remains deliberately excluded because
    // it says nothing about the piste type.
    kind: 'ski_downhill',
    where: `(o.tags ->> 'piste:type' = 'downhill')`,
  },
  {
    // "Langlauf" — OSM's piste:type=nordic is the cross-country-specific tag.
    kind: 'ski_nordic',
    where: `(o.tags ->> 'piste:type' = 'nordic')`,
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
    // `historic=memorial`/`archaeological_site` deliberately excluded: verified
    // live against prod (2026-08-15, WP-8 calibration) that they make up ~55%
    // of all matches (93.8k/196.7k memorial alone — a war memorial in nearly
    // every village) and turn the per-auction density count bimodal — 75% of
    // a random sample had zero attractions within 30km, the rest jumped
    // straight to the thousands, with almost nothing in between. Dropping
    // just these two tags produces a smooth, usable distribution (median 105,
    // p90 ~252 in the same sample) without losing genuinely visit-worthy
    // sights (museum/viewpoint/zoo/theme_park/castle/monument all kept).
    kind: 'attraction',
    where: `(COALESCE(o.tags ->> 'historic', '') NOT IN ('memorial', 'archaeological_site')
      AND (o.tags ->> 'tourism' IN ('attraction', 'museum', 'viewpoint', 'theme_park', 'zoo')
        OR o.tags ->> 'historic' IN ('castle', 'monument', 'fort')))`,
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
      return { result: await buildGeoFeatures(drizzle(client), signal) }
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
export async function buildGeoFeatures(db: NodePgDatabase, signal: AbortSignal): Promise<BuildGeoFeaturesResult> {
  const startedAt = Date.now()
  await acquireRebuildLock(db)
  try {
    const epoch = await nextFeaturesEpoch(db)
    console.log(`[build-geo-features] start, epoch=${epoch}`)

    const perKind: Record<string, { inserted: number; skipped: number }> = {}
    for (const mapping of KIND_MAPPINGS) {
      throwIfTaskAborted(signal)
      const kindStartedAt = Date.now()
      const outcome = await buildKind(db, mapping, epoch, signal)
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
    const deletedStale = await swapInEpoch(db, epoch)
    await db.execute(sql`ANALYZE geo_features`)

    const durationMs = Date.now() - startedAt
    console.log(`[build-geo-features] done in ${(durationMs / 1000).toFixed(0)}s, deleted ${deletedStale} stale rows`)

    return { epoch, perKind, deletedStale, durationMs }
  } finally {
    await releaseRebuildLock(db)
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

async function acquireRebuildLock(db: NodePgDatabase): Promise<void> {
  const { rows } = await db.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_lock(${REBUILD_LOCK_KEY}) AS locked`)
  if (!rows[0]?.locked) {
    throw new Error('[build-geo-features] another rebuild is already running (advisory lock held), skipping this run')
  }
}

async function releaseRebuildLock(db: NodePgDatabase): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_advisory_unlock(${REBUILD_LOCK_KEY})`)
  } catch (err) {
    // The lock dies with the session anyway, so a failed unlock (e.g. the
    // connection already broke) must not mask the original error.
    console.warn(`[build-geo-features] releasing advisory lock failed: ${(err as Error).message}`)
  }
}

// Both tables, not just geo_features: a successful rebuild that produced no
// rows at all (osm_local_elements empty, as it was after the WP-0 reset)
// leaves geo_features empty but geo_features_epochs holding that epoch's
// marker. Counting from geo_features alone would then hand out an already-used
// epoch number, the marker insert would hit ON CONFLICT DO NOTHING, MAX(epoch)
// would stay behind — and readers would ignore every row the rebuild just
// wrote. The epoch counter has to be monotonic across both.
export async function nextFeaturesEpoch(db: NodePgDatabase): Promise<number> {
  const { rows } = await db.execute<{ next_epoch: number }>(sql`
    SELECT GREATEST(
      (SELECT COALESCE(MAX(features_epoch), 0) FROM geo_features),
      (SELECT COALESCE(MAX(epoch), 0) FROM geo_features_epochs)
    ) + 1 AS next_epoch
  `)
  return rows[0]?.next_epoch ?? 1
}

/**
 * Publishes `epoch`: drops every older row and records the completion marker
 * in one transaction. Atomicity is the point — WP-5's metrics job pins itself
 * to MAX(geo_features_epochs.epoch) and then measures against that epoch's
 * rows, so a window where the old rows are already gone but the new marker is
 * not yet visible would have it silently measure against nothing. Returns the
 * number of stale rows removed.
 */
async function swapInEpoch(db: NodePgDatabase, epoch: number): Promise<number> {
  return db.transaction(async (tx) => {
    const { rowCount } = await tx.execute(sql`DELETE FROM geo_features WHERE features_epoch < ${epoch}`)
    // Only now is this epoch complete — readers (WP-5's auction_geo_metrics
    // precompute job) resolve the current epoch via this table, never via
    // MAX(features_epoch) on geo_features directly, so a rebuild in progress
    // is never mistaken for done (see schema/geo.ts's geoFeaturesEpochs
    // comment).
    await tx.execute(sql`INSERT INTO geo_features_epochs (epoch) VALUES (${epoch}) ON CONFLICT (epoch) DO NOTHING`)
    return rowCount ?? 0
  })
}

// One INSERT ... SELECT per kind (committed as its own implicit transaction,
// not batched into a shared one) so a failure in kind 14 never rolls back the
// 13 before it, and a stuck kind never holds a lock for the whole run.
async function buildKind(
  db: NodePgDatabase,
  mapping: KindMapping,
  epoch: number,
  signal: AbortSignal,
): Promise<{ inserted: number; skipped: number }> {
  throwIfTaskAborted(signal)
  const query = sql`
    INSERT INTO geo_features (kind, name, country, osm_type, osm_id, geom_3035, features_epoch)
    SELECT ${mapping.kind}, o.tags ->> 'name', o.country, o.osm_type, o.osm_id, geom_3035, ${epoch}
    FROM osm_local_elements o
    ${sql.raw(GEOMETRY_PIECE_JOIN)}
    WHERE ${sql.raw(mapping.where)}
  `
  try {
    const res = await db.execute(query)
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
      `[build-geo-features] kind=${mapping.kind} bulk insert failed (${pgErrorMessage(err)}), retrying row by row`,
    )
    return await buildKindPerRow(db, mapping, epoch, signal, err)
  }
}

// SQLSTATE classes that can never be caused by one bad geometry:
// 08 connection, 28 invalid authorization, 2B/2D/40 transaction state,
// 42 syntax/access rule (missing table/column, no permission),
// 53 insufficient resources, 54 program limit, 57 operator intervention
// (incl. 57014 statement_timeout), 58 external system error.
const SYSTEMIC_SQLSTATE_CLASSES = ['08', '28', '2B', '2D', '40', '42', '53', '54', '57', '58']

export function isSystemicDatabaseError(err: unknown): boolean {
  // pgErrorCode, not err.code: queries go through Drizzle, which hides the
  // SQLSTATE inside DrizzleQueryError.cause. Reading err.code directly would
  // classify every systemic failure as a single bad geometry — the per-row
  // pass would then report the whole kind as "skipped" and the rebuild would
  // go on to delete the previous epoch's still-good rows.
  const code = pgErrorCode(err)
  return code !== undefined && SYSTEMIC_SQLSTATE_CLASSES.includes(code.slice(0, 2))
}

async function buildKindPerRow(
  db: NodePgDatabase,
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
  const { rows: candidates } = await db.execute<{ osm_type: string; osm_id: number; country: string }>(sql`
    SELECT o.osm_type, o.osm_id, o.country FROM osm_local_elements o WHERE ${sql.raw(mapping.where)}
  `)

  let inserted = 0
  let skipped = 0
  for (const { osm_type, osm_id, country } of candidates) {
    throwIfTaskAborted(signal)
    try {
      const res = await db.execute(sql`
        INSERT INTO geo_features (kind, name, country, osm_type, osm_id, geom_3035, features_epoch)
        SELECT ${mapping.kind}, o.tags ->> 'name', o.country, o.osm_type, o.osm_id, geom_3035, ${epoch}
        FROM osm_local_elements o
        ${sql.raw(GEOMETRY_PIECE_JOIN)}
        WHERE o.osm_type = ${osm_type} AND o.osm_id = ${osm_id} AND o.country = ${country}
      `)
      inserted += res.rowCount ?? 0
    } catch (err) {
      if (isSystemicDatabaseError(err)) throw err
      skipped++
      console.warn(`[build-geo-features] kind=${mapping.kind} skipped ${osm_type}/${osm_id}/${country}: ${pgErrorMessage(err)}`)
    }
  }
  // Every single candidate failing is not "a handful of broken geometries" —
  // it's the bulk error having been systemic after all, under a SQLSTATE the
  // classification above doesn't cover. Surface it instead of reporting an
  // empty kind as a successful rebuild.
  if (inserted === 0 && skipped === candidates.length && candidates.length > 0) throw bulkError
  return { inserted, skipped }
}
