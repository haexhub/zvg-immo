import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool, PoolClient } from 'pg'

// buildGeoFeatures itself never touches Nitro's defineTask/useRuntimeConfig
// (only the default-exported task wrapper does), but the module still
// declares `export default defineTask(...)` at the top level, so importing
// the file at all requires this global to exist — same stub every other
// server/tasks/*.test.ts uses.
vi.stubGlobal('defineTask', (definition: unknown) => definition)

const { buildGeoFeatures, isSystemicDatabaseError, nextFeaturesEpoch } = await import('./build-geo-features')

// Runs without a database, unlike the suite below: this classification decides
// whether a failed rebuild deletes the previous epoch's rows, and the inserts
// now go through Drizzle, which hides the SQLSTATE inside its own wrapper.
describe('isSystemicDatabaseError', () => {
  const wrapped = (cause: unknown) =>
    Object.assign(new Error('Failed query: insert into geo_features\nparams: lake,7'), { cause })

  it('classifies a Drizzle-wrapped systemic SQLSTATE as systemic', () => {
    for (const code of ['53200', '57014', '42P01', '08006']) {
      expect(isSystemicDatabaseError(wrapped(Object.assign(new Error('boom'), { code })))).toBe(true)
    }
  })

  it('still treats a single broken geometry as non-systemic', () => {
    const geometryError = Object.assign(new Error('Geometry contains an interior ring outside'), { code: 'XX000' })
    expect(isSystemicDatabaseError(wrapped(geometryError))).toBe(false)
    expect(isSystemicDatabaseError(geometryError)).toBe(false)
    expect(isSystemicDatabaseError(new Error('boom'))).toBe(false)
  })
})

// Real Postgres, not a mock: this job's correctness lives entirely in SQL
// (ST_MakeValid/ST_Transform/ST_Subdivide, the lake/river tag exclusion, the
// features_epoch cleanup) — a mocked query() can't catch a broken geometry
// pipeline or a delete condition that's off by one epoch (the exact class of
// bug PR #315 found: a mocked unit test passed while the real INSERT failed
// outright). Requires the docker-compose `db` service (or an equivalent
// local Postgres+PostGIS instance) with migrations applied; skipped
// otherwise, same as current-auctions.test.ts's real-Postgres suite.
const TEST_DB = process.env.TEST_DATABASE_URL
const describeDb = TEST_DB ? describe : describe.skip

// Reserved for this file only, never used by real crawl data or other
// real-Postgres suites — every fixture row and assertion is scoped to it.
//
// The fixture scoping is NOT enough to make this suite safe on a shared
// database, though: buildGeoFeatures rebuilds from *all* of
// osm_local_elements and its stale-epoch cleanup is a table-wide
// `DELETE FROM geo_features WHERE features_epoch < $1` with no country
// filter, and geo_features_epochs has no country column to scope by at all.
// Point TEST_DATABASE_URL at a disposable database — the guard in beforeAll
// below refuses to run against one that holds foreign rows — and do not run
// this file concurrently with build-auction-geo-metrics.test.ts against the
// same database: both touch the unscoped geo_features_epochs table, and this
// file's systemic-failure test installs a trigger on all of geo_features
// that would catch the other suite's inserts too. `vitest run <one file>`
// per invocation, not the whole suite in parallel, when TEST_DATABASE_URL is set.
const TEST_COUNTRY = 'zz-geo-features-test'

// A second country, used only by the border-feature test below: Geofabrik's
// per-country extracts overlap at borders/coastlines, so the same real-world
// element can land in two countries' osm_local_elements with the same
// osm_type/osm_id (see schema/geo.ts's PK comment) — this stands in for that.
const BORDER_COUNTRY = 'zz-geo-features-test-2'

// osm_type/osm_id pairs used by the fixture below.
const IDS = {
  sea: { osm_type: 'way', osm_id: 900_001 },
  lake: { osm_type: 'way', osm_id: 900_002 },
  riverWaterPolygon: { osm_type: 'way', osm_id: 900_003 }, // natural=water + water=river: must NOT become a lake
  river: { osm_type: 'way', osm_id: 900_004 },
  peak: { osm_type: 'node', osm_id: 900_005 },
  airport: { osm_type: 'way', osm_id: 900_006 },
  invalidLake: { osm_type: 'way', osm_id: 900_007 }, // hole-outside-shell: ST_Transform throws on it
  building: { osm_type: 'way', osm_id: 900_008 }, // must never appear in geo_features
  borderLake: { osm_type: 'way', osm_id: 900_009 }, // same osm_id, once per country — see BORDER_COUNTRY above
  lowPeak: { osm_type: 'node', osm_id: 900_010 }, // natural=peak but ele below the mountain floor — must not surface as 'peak'
  smallAirfield: { osm_type: 'way', osm_id: 900_011 }, // aerodrome without iata — must not surface as 'airport'
} as const

async function seedFixture(client: PoolClient): Promise<void> {
  // A ~300-point sine-wave coastline: large enough that ST_Subdivide (128
  // vertices/piece) actually splits it into multiple rows, the same way a
  // real coastline way would — a straight 4-point square never exercises the
  // split path at all.
  await client.query(
    `INSERT INTO osm_local_elements (osm_type, osm_id, geom, tags, country)
     SELECT $1, $2,
       ST_SetSRID(ST_MakeLine(ARRAY(
         SELECT ST_MakePoint(9 + i * 0.01, 54 + sin(i / 10.0) * 0.3) FROM generate_series(0, 300) AS i
       )), 4326),
       '{"natural": "coastline", "name": "Testkueste"}'::jsonb,
       $3`,
    [IDS.sea.osm_type, IDS.sea.osm_id, TEST_COUNTRY],
  )

  await client.query(
    `INSERT INTO osm_local_elements (osm_type, osm_id, geom, tags, country)
     VALUES ($1, $2, ST_GeomFromText('POLYGON((13 52,13.01 52,13.01 52.01,13 52.01,13 52))', 4326),
       '{"natural": "water", "name": "Testsee"}'::jsonb, $3)`,
    [IDS.lake.osm_type, IDS.lake.osm_id, TEST_COUNTRY],
  )

  // Same natural=water tag as a real lake, but water=river — the exclusion
  // this fixture is here to prove. Must not surface as 'lake', and (having
  // no waterway tag) must not surface as 'river' either: zero geo_features
  // rows expected for this element under any kind.
  await client.query(
    `INSERT INTO osm_local_elements (osm_type, osm_id, geom, tags, country)
     VALUES ($1, $2, ST_GeomFromText('POLYGON((14 52,14.01 52,14.01 52.01,14 52.01,14 52))', 4326),
       '{"natural": "water", "water": "river", "name": "Flussflaeche"}'::jsonb, $3)`,
    [IDS.riverWaterPolygon.osm_type, IDS.riverWaterPolygon.osm_id, TEST_COUNTRY],
  )

  await client.query(
    `INSERT INTO osm_local_elements (osm_type, osm_id, geom, tags, country)
     VALUES ($1, $2, ST_GeomFromText('LINESTRING(15 52,15.01 52.01,15.02 52.02)', 4326),
       '{"waterway": "river", "name": "Testfluss"}'::jsonb, $3)`,
    [IDS.river.osm_type, IDS.river.osm_id, TEST_COUNTRY],
  )

  // A bare point — must come through as exactly one row (no subdivision).
  await client.query(
    `INSERT INTO osm_local_elements (osm_type, osm_id, geom, tags, country)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint(11, 47), 4326),
       '{"natural": "peak", "name": "Testberg", "ele": "1493"}'::jsonb, $3)`,
    [IDS.peak.osm_type, IDS.peak.osm_id, TEST_COUNTRY],
  )

  // Same tagging as a real peak, but below the mountain floor — stands in
  // for the flatland "peaks" (dunes, spoil mounds) that made nearMountain
  // match almost every German auction before this floor existed.
  await client.query(
    `INSERT INTO osm_local_elements (osm_type, osm_id, geom, tags, country)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint(11.5, 47), 4326),
       '{"natural": "peak", "name": "Testhuegel", "ele": "20"}'::jsonb, $3)`,
    [IDS.lowPeak.osm_type, IDS.lowPeak.osm_id, TEST_COUNTRY],
  )

  await client.query(
    `INSERT INTO osm_local_elements (osm_type, osm_id, geom, tags, country)
     VALUES ($1, $2, ST_GeomFromText('POLYGON((16 52,16.02 52,16.02 52.02,16 52.02,16 52))', 4326),
       '{"aeroway": "aerodrome", "name": "Testflughafen", "iata": "TST"}'::jsonb, $3)`,
    [IDS.airport.osm_type, IDS.airport.osm_id, TEST_COUNTRY],
  )

  // Same aeroway tag as a real airport, but no iata code — stands in for the
  // small general-aviation airfields that made nearAirport barely exclude
  // anything in Germany before this filter existed.
  await client.query(
    `INSERT INTO osm_local_elements (osm_type, osm_id, geom, tags, country)
     VALUES ($1, $2, ST_GeomFromText('POLYGON((16.5 52,16.52 52,16.52 52.02,16.5 52.02,16.5 52))', 4326),
       '{"aeroway": "aerodrome", "name": "Testflugplatz", "icao": "EDZZ"}'::jsonb, $3)`,
    [IDS.smallAirfield.osm_type, IDS.smallAirfield.osm_id, TEST_COUNTRY],
  )

  // A hole entirely outside the shell — GEOS reports it invalid, and
  // ST_MakeValid's fix for this shape ends up with a coordinate outside
  // EPSG:4326's valid latitude range, which ST_Transform hard-errors on
  // ("Invalid coordinate"). Tagged natural=water (a lake candidate) so it
  // sits in the same bulk INSERT as the good lake row above — proving one
  // bad geometry doesn't take the whole kind down with it.
  await client.query(
    `INSERT INTO osm_local_elements (osm_type, osm_id, geom, tags, country)
     VALUES ($1, $2, ST_GeomFromText(
         'POLYGON((0 0,10 0,10 10,0 10,0 0),(100 100,110 100,110 110,100 110,100 100))', 4326),
       '{"natural": "water", "name": "Kaputter See"}'::jsonb, $3)`,
    [IDS.invalidLake.osm_type, IDS.invalidLake.osm_id, TEST_COUNTRY],
  )

  await client.query(
    `INSERT INTO osm_local_elements (osm_type, osm_id, geom, tags, country)
     VALUES ($1, $2, ST_GeomFromText('POLYGON((17 52,17.01 52,17.01 52.01,17 52.01,17 52))', 4326),
       '{"building": "yes"}'::jsonb, $3)`,
    [IDS.building.osm_type, IDS.building.osm_id, TEST_COUNTRY],
  )

  // Same osm_type/osm_id, once per country — the PK is (osm_type, osm_id,
  // country), so both rows coexist. Tagged natural=water so it shares the
  // 'lake' kind with invalidLake above, which forces buildKindPerRow's
  // fallback path for every 'lake' candidate, including this one.
  for (const country of [TEST_COUNTRY, BORDER_COUNTRY]) {
    await client.query(
      `INSERT INTO osm_local_elements (osm_type, osm_id, geom, tags, country)
       VALUES ($1, $2, ST_GeomFromText('POLYGON((18 52,18.01 52,18.01 52.01,18 52.01,18 52))', 4326),
         '{"natural": "water", "name": "Grenzsee"}'::jsonb, $3)`,
      [IDS.borderLake.osm_type, IDS.borderLake.osm_id, country],
    )
  }
}

interface FeatureRow {
  kind: string
  osm_type: string
  osm_id: string
  features_epoch: number
}

async function readFeatures(pool: Pool): Promise<FeatureRow[]> {
  const { rows } = await pool.query<FeatureRow>(
    'SELECT kind, osm_type, osm_id, features_epoch FROM geo_features WHERE country = $1 ORDER BY kind, osm_id',
    [TEST_COUNTRY],
  )
  return rows
}

function countFor(rows: FeatureRow[], kind: string, osmId: number): number {
  return rows.filter((r) => r.kind === kind && Number(r.osm_id) === osmId).length
}

describeDb('buildGeoFeatures (real Postgres)', () => {
  let pool: Pool

  beforeAll(async () => {
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: TEST_DB })
    for (const table of ['geo_features', 'osm_local_elements']) {
      const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE country NOT IN ($1, $2) LIMIT 1`, [TEST_COUNTRY, BORDER_COUNTRY])
      if (rows.length > 0) {
        throw new Error(
          `${table} holds rows outside ${TEST_COUNTRY}/${BORDER_COUNTRY}. This suite rebuilds geo_features `
          + 'table-wide and would destroy them — point TEST_DATABASE_URL at a disposable database.',
        )
      }
    }
  })

  afterAll(async () => {
    await pool.query('DELETE FROM geo_features WHERE country IN ($1, $2)', [TEST_COUNTRY, BORDER_COUNTRY])
    await pool.query('DELETE FROM osm_local_elements WHERE country IN ($1, $2)', [TEST_COUNTRY, BORDER_COUNTRY])
    await pool.query('DELETE FROM geo_features_epochs')
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM geo_features WHERE country IN ($1, $2)', [TEST_COUNTRY, BORDER_COUNTRY])
    await pool.query('DELETE FROM osm_local_elements WHERE country IN ($1, $2)', [TEST_COUNTRY, BORDER_COUNTRY])
    // Epochs are a global sequence (not scoped to a country), so a leftover
    // row from a previous test's epoch could make nextFeaturesEpoch() start
    // from an unexpected number — clear the whole table between tests.
    await pool.query('DELETE FROM geo_features_epochs')
    const client = await pool.connect()
    try {
      await seedFixture(client)
    } finally {
      client.release()
    }
  })

  it('maps kinds correctly, excludes river water from lake, only subdivides non-points, skips a broken geometry without losing the kind, and is idempotent', async () => {
    const client = await pool.connect()
    try {
      const signal = new AbortController().signal

      // --- first run ---
      const first = await buildGeoFeatures(drizzle(client), signal)
      const afterFirst = await readFeatures(pool)

      // Kind mapping + lake/river exclusion.
      expect(countFor(afterFirst, 'lake', IDS.lake.osm_id)).toBe(1)
      expect(countFor(afterFirst, 'river', IDS.river.osm_id)).toBeGreaterThanOrEqual(1)
      expect(countFor(afterFirst, 'peak', IDS.peak.osm_id)).toBe(1)
      expect(countFor(afterFirst, 'airport', IDS.airport.osm_id)).toBeGreaterThanOrEqual(1)
      // natural=peak below the mountain floor must not surface as 'peak'.
      expect(afterFirst.some((r) => Number(r.osm_id) === IDS.lowPeak.osm_id)).toBe(false)
      // aerodrome without an iata code must not surface as 'airport'.
      expect(afterFirst.some((r) => Number(r.osm_id) === IDS.smallAirfield.osm_id)).toBe(false)
      // natural=water + water=river must not surface as lake nor as river.
      expect(afterFirst.some((r) => Number(r.osm_id) === IDS.riverWaterPolygon.osm_id)).toBe(false)
      // building is never mapped to any kind.
      expect(afterFirst.some((r) => Number(r.osm_id) === IDS.building.osm_id)).toBe(false)

      // Points are never subdivided; the coastline (301 vertices) is.
      const seaPieces = afterFirst.filter((r) => r.kind === 'sea' && Number(r.osm_id) === IDS.sea.osm_id)
      expect(seaPieces.length).toBeGreaterThan(1)
      expect(countFor(afterFirst, 'peak', IDS.peak.osm_id)).toBe(1)

      // The broken hole-outside-shell geometry must be skipped, not
      // inserted, and not allowed to take the rest of the 'lake' kind down
      // with it (the good lake row above is still present).
      expect(afterFirst.some((r) => Number(r.osm_id) === IDS.invalidLake.osm_id)).toBe(false)
      expect(first.perKind.lake?.skipped).toBeGreaterThanOrEqual(1)
      expect(first.perKind.lake?.inserted).toBeGreaterThanOrEqual(1)

      // WP-6-only kinds stay empty today (tags not imported yet).
      for (const emptyKind of ['ski_area', 'hiking_route', 'mtb_route', 'paddling', 'attraction', 'tourism_supply']) {
        expect(first.perKind[emptyKind]).toEqual({ inserted: 0, skipped: 0 })
      }

      expect(afterFirst.every((r) => r.features_epoch === first.epoch)).toBe(true)

      // Epoch is only "complete" for readers once the marker row exists —
      // this is what auction_geo_metrics's precompute job resolves instead
      // of MAX(features_epoch) on geo_features directly.
      const firstMarker = await pool.query('SELECT 1 FROM geo_features_epochs WHERE epoch = $1', [first.epoch])
      expect(firstMarker.rows).toHaveLength(1)

      // --- second run: must not duplicate anything ---
      const second = await buildGeoFeatures(drizzle(client), signal)
      const afterSecond = await readFeatures(pool)

      expect(second.epoch).toBe(first.epoch + 1)
      const secondMarker = await pool.query('SELECT 1 FROM geo_features_epochs WHERE epoch = $1', [second.epoch])
      expect(secondMarker.rows).toHaveLength(1)
      // Same fixture, same geometries -> identical row set (by kind/osm_id
      // count), not doubled.
      expect(afterSecond.length).toBe(afterFirst.length)
      expect(countFor(afterSecond, 'lake', IDS.lake.osm_id)).toBe(1)
      expect(countFor(afterSecond, 'sea', IDS.sea.osm_id)).toBe(seaPieces.length)

      // Old epoch's rows were purged only after the new epoch finished.
      expect(afterSecond.every((r) => r.features_epoch === second.epoch)).toBe(true)
      const stale = await pool.query('SELECT count(*) FROM geo_features WHERE country = $1 AND features_epoch < $2', [
        TEST_COUNTRY,
        second.epoch,
      ])
      expect(Number(stale.rows[0]?.count)).toBe(0)
    } finally {
      client.release()
    }
  })

  it('refuses to rebuild while another process holds the advisory lock', async () => {
    const holder = await pool.connect()
    const client = await pool.connect()
    try {
      // Same key as build-geo-features.ts's REBUILD_LOCK_KEY — stands in for a
      // second app container mid-rebuild, which runExclusiveTask (in-process
      // only) would not notice.
      await holder.query('SELECT pg_advisory_lock($1)', [4_820_251_104])
      await expect(buildGeoFeatures(drizzle(client), new AbortController().signal)).rejects.toThrow(/another rebuild/)
      // Nothing was written, and above all nothing was deleted.
      expect(await readFeatures(pool)).toEqual([])
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [4_820_251_104])
      holder.release()
      client.release()
    }
  })

  it('keeps handing out fresh epochs after a rebuild that produced no rows at all', async () => {
    const client = await pool.connect()
    try {
      const signal = new AbortController().signal
      // An empty source table is what the WP-0 reset actually left behind —
      // the rebuild succeeds and records its marker, but geo_features stays
      // empty, so a counter derived from geo_features alone would hand out
      // that same epoch again on the next run.
      await pool.query('DELETE FROM osm_local_elements WHERE country IN ($1, $2)', [TEST_COUNTRY, BORDER_COUNTRY])
      const empty = await buildGeoFeatures(drizzle(client), signal)
      expect(await readFeatures(pool)).toEqual([])

      const client2 = await pool.connect()
      try {
        await seedFixture(client2)
      } finally {
        client2.release()
      }
      const populated = await buildGeoFeatures(drizzle(client), signal)
      expect(populated.epoch).toBeGreaterThan(empty.epoch)

      // The decisive part: what readers resolve as the newest complete epoch
      // is the one the rows were actually written under. Equal epochs here
      // would leave every row invisible to the metrics job.
      const { rows } = await pool.query<{ epoch: number }>('SELECT MAX(epoch) AS epoch FROM geo_features_epochs')
      expect(rows[0]!.epoch).toBe(populated.epoch)
      const written = await readFeatures(pool)
      expect(written.length).toBeGreaterThan(0)
      expect(written.every((r) => r.features_epoch === populated.epoch)).toBe(true)
    } finally {
      client.release()
    }
  })

  it('propagates a systemic insert failure instead of deleting the previous epoch', async () => {
    const client = await pool.connect()
    try {
      const signal = new AbortController().signal
      const first = await buildGeoFeatures(drizzle(client), signal)
      expect((await readFeatures(pool)).length).toBeGreaterThan(0)

      // 53200 (out_of_memory) stands in for any systemic failure — schema,
      // permission, timeout, resources. It hits every row, so the per-row
      // fallback would otherwise report the whole rebuild as "skipped but
      // successful" and go on to delete the previous epoch's still-good rows.
      await client.query(`
        CREATE FUNCTION zz_geo_features_boom() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated systemic failure' USING ERRCODE = '53200'; END $$;
        CREATE TRIGGER zz_geo_features_boom BEFORE INSERT ON geo_features
          FOR EACH ROW EXECUTE FUNCTION zz_geo_features_boom();
      `)
      let failedEpoch: number | undefined
      try {
        // The epoch this next, failing run will attempt to write under —
        // asked of the same function buildGeoFeatures uses, not a copy of its
        // query, so the two can't drift apart.
        failedEpoch = await nextFeaturesEpoch(drizzle(client))
        // Asserted on the cause, not the message: Drizzle rethrows a
        // DrizzleQueryError whose own message is only `Failed query: <sql>`.
        await expect(buildGeoFeatures(drizzle(client), signal)).rejects.toMatchObject({
          cause: expect.objectContaining({ code: '53200' }),
        })
      } finally {
        await client.query('DROP TRIGGER zz_geo_features_boom ON geo_features; DROP FUNCTION zz_geo_features_boom();')
      }

      // The failed epoch never becomes visible to readers — no marker row,
      // ever, for an epoch that didn't complete.
      const failedMarker = await pool.query('SELECT 1 FROM geo_features_epochs WHERE epoch = $1', [failedEpoch])
      expect(failedMarker.rows).toHaveLength(0)

      const survivors = await readFeatures(pool)
      expect(survivors.length).toBeGreaterThan(0)
      expect(survivors.every((r) => r.features_epoch === first.epoch)).toBe(true)
    } finally {
      client.release()
    }
  })

  it('inserts a border feature once per country via the per-row fallback, not once per candidate', async () => {
    const client = await pool.connect()
    try {
      // invalidLake forces buildKindPerRow for the whole 'lake' kind, which
      // includes borderLake — present under both TEST_COUNTRY and
      // BORDER_COUNTRY with the same osm_type/osm_id. Before country joined
      // the PK, the fallback's candidate SELECT and rowSql both ignored
      // country: two candidates (one per country) each matched both rows,
      // inserting the border feature 4 times instead of 2.
      await buildGeoFeatures(drizzle(client), new AbortController().signal)

      const { rows } = await client.query<{ country: string; n: string }>(
        `SELECT country, count(*) AS n FROM geo_features
         WHERE kind = 'lake' AND osm_type = $1 AND osm_id = $2
         GROUP BY country ORDER BY country`,
        [IDS.borderLake.osm_type, IDS.borderLake.osm_id],
      )

      expect(rows).toEqual([
        { country: TEST_COUNTRY, n: '1' },
        { country: BORDER_COUNTRY, n: '1' },
      ])
    } finally {
      client.release()
    }
  })
})
