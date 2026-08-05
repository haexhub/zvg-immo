import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'

// buildGeoFeatures itself never touches Nitro's defineTask/useRuntimeConfig
// (only the default-exported task wrapper does), but the module still
// declares `export default defineTask(...)` at the top level, so importing
// the file at all requires this global to exist — same stub every other
// server/tasks/*.test.ts uses.
vi.stubGlobal('defineTask', (definition: unknown) => definition)

const { buildGeoFeatures } = await import('./build-geo-features')

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
// real-Postgres suites — every fixture row and assertion is scoped to it so
// this test can run against a shared/persistent dev database without
// touching real osm_local_elements/geo_features rows.
const TEST_COUNTRY = 'zz-geo-features-test'

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
       '{"natural": "peak", "name": "Testberg"}'::jsonb, $3)`,
    [IDS.peak.osm_type, IDS.peak.osm_id, TEST_COUNTRY],
  )

  await client.query(
    `INSERT INTO osm_local_elements (osm_type, osm_id, geom, tags, country)
     VALUES ($1, $2, ST_GeomFromText('POLYGON((16 52,16.02 52,16.02 52.02,16 52.02,16 52))', 4326),
       '{"aeroway": "aerodrome", "name": "Testflughafen"}'::jsonb, $3)`,
    [IDS.airport.osm_type, IDS.airport.osm_id, TEST_COUNTRY],
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
  })

  afterAll(async () => {
    await pool.query('DELETE FROM geo_features WHERE country = $1', [TEST_COUNTRY])
    await pool.query('DELETE FROM osm_local_elements WHERE country = $1', [TEST_COUNTRY])
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM geo_features WHERE country = $1', [TEST_COUNTRY])
    await pool.query('DELETE FROM osm_local_elements WHERE country = $1', [TEST_COUNTRY])
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
      const first = await buildGeoFeatures(client, signal)
      const afterFirst = await readFeatures(pool)

      // Kind mapping + lake/river exclusion.
      expect(countFor(afterFirst, 'lake', IDS.lake.osm_id)).toBe(1)
      expect(countFor(afterFirst, 'river', IDS.river.osm_id)).toBeGreaterThanOrEqual(1)
      expect(countFor(afterFirst, 'peak', IDS.peak.osm_id)).toBe(1)
      expect(countFor(afterFirst, 'airport', IDS.airport.osm_id)).toBeGreaterThanOrEqual(1)
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

      // --- second run: must not duplicate anything ---
      const second = await buildGeoFeatures(client, signal)
      const afterSecond = await readFeatures(pool)

      expect(second.epoch).toBe(first.epoch + 1)
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
})
