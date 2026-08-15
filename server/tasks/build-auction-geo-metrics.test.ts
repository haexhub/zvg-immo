import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool, PoolClient } from 'pg'

// Same global stub every server/tasks/*.test.ts needs — buildAuctionGeoMetrics
// itself never touches Nitro's defineTask, but importing the module at all
// requires the global to exist because of the top-level `export default
// defineTask(...)`.
vi.stubGlobal('defineTask', (definition: unknown) => definition)

const { buildAuctionGeoMetrics } = await import('./build-auction-geo-metrics')

// Real Postgres, not a mock — this job's correctness is entirely in SQL
// (ST_Transform/ST_DWithin/KNN, the epoch/point_hash incremental-skip logic,
// the cutoff-vs-NULL distinction). Same real-Postgres suite convention as
// build-geo-features.test.ts; skipped without TEST_DATABASE_URL.
const TEST_DB = process.env.TEST_DATABASE_URL
const describeDb = TEST_DB ? describe : describe.skip

// This job's candidate query is `auctions` table-wide (any geocoded auction,
// not scoped to a country) and geo_features_epochs has no country column at
// all — unlike build-geo-features.test.ts's per-table guard, there is no way
// to scope this suite's ownership check to "our rows only". Point
// TEST_DATABASE_URL at a disposable database; the guard below refuses to run
// against one that already holds other auctions with coordinates or any
// pre-existing epoch, either of which this suite's assertions and cleanup
// would otherwise corrupt or be corrupted by. Also do not run this file
// concurrently with build-geo-features.test.ts against the same database —
// see that file's header comment.
const TEST_COUNTRY = 'zz-geo-metrics-test'
const PLATFORM = 'zz-geo-metrics-test-platform'
const EXTERNAL_ID = 'zz-1'

// Auction position; every geo_features fixture below is placed relative to
// this point.
const AUCTION_LNG = 13.0
const AUCTION_LAT = 52.0

let nextOsmId = 900_101
function freshOsmId(): number {
  return nextOsmId++
}

async function seedGeoFeature(
  client: PoolClient,
  kind: string,
  lng: number,
  lat: number,
): Promise<void> {
  await client.query(
    `INSERT INTO geo_features (kind, name, country, osm_type, osm_id, geom_3035, features_epoch)
     VALUES ($1, $2, $3, 'node', $4, ST_Transform(ST_SetSRID(ST_MakePoint($5, $6), 4326), 3035), 1)`,
    [kind, `test-${kind}`, TEST_COUNTRY, freshOsmId(), lng, lat],
  )
}

async function seedFixture(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO auctions (platform, external_id, country, region, authority, case_number, cancelled, lat, lng)
     VALUES ($1, $2, $3, 'Test', 'Testbehörde', '1 K 1/26', false, $4, $5)`,
    [PLATFORM, EXTERNAL_ID, TEST_COUNTRY, AUCTION_LAT, AUCTION_LNG],
  )
  await client.query('INSERT INTO geo_features_epochs (epoch) VALUES (1)')

  // Within every category's cutoff — small offsets at this latitude are a
  // few km, well inside the 50-200km cutoffs.
  await seedGeoFeature(client, 'sea', AUCTION_LNG + 0.05, AUCTION_LAT)
  await seedGeoFeature(client, 'lake', AUCTION_LNG + 0.1, AUCTION_LAT)
  await seedGeoFeature(client, 'river', AUCTION_LNG - 0.1, AUCTION_LAT)
  await seedGeoFeature(client, 'peak', AUCTION_LNG, AUCTION_LAT + 0.05)
  // Deliberately outside the 100km airport cutoff (~500km away at this
  // latitude) — must surface as NULL, not a huge distance.
  await seedGeoFeature(client, 'airport', AUCTION_LNG + 7, AUCTION_LAT)
  // tourism_density_count: two within the 10km radius, one well outside it.
  await seedGeoFeature(client, 'tourism_supply', AUCTION_LNG + 0.02, AUCTION_LAT)
  await seedGeoFeature(client, 'tourism_supply', AUCTION_LNG - 0.02, AUCTION_LAT)
  await seedGeoFeature(client, 'tourism_supply', AUCTION_LNG + 1, AUCTION_LAT)
  // Within the 20km hiking cutoff.
  await seedGeoFeature(client, 'hiking_route', AUCTION_LNG, AUCTION_LAT - 0.05)
  // attraction_density_count: two within the 30km radius, one well outside it.
  await seedGeoFeature(client, 'attraction', AUCTION_LNG + 0.2, AUCTION_LAT)
  await seedGeoFeature(client, 'attraction', AUCTION_LNG - 0.2, AUCTION_LAT)
  await seedGeoFeature(client, 'attraction', AUCTION_LNG + 1, AUCTION_LAT)
}

interface MetricsRow {
  dist_sea_m: number | null
  dist_lake_m: number | null
  dist_river_m: number | null
  dist_mountain_m: number | null
  dist_airport_m: number | null
  dist_ski_m: number | null
  dist_hiking_m: number | null
  tourism_density_count: number | null
  attraction_density_count: number | null
  point_hash: string | null
  features_epoch: number
  computed_at: Date | null
}

async function readMetrics(pool: Pool): Promise<MetricsRow | undefined> {
  const { rows } = await pool.query<MetricsRow>(
    'SELECT * FROM auction_geo_metrics WHERE platform = $1 AND external_id = $2',
    [PLATFORM, EXTERNAL_ID],
  )
  return rows[0]
}

describeDb('buildAuctionGeoMetrics (real Postgres)', () => {
  let pool: Pool

  beforeAll(async () => {
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: TEST_DB })
    const { rows: foreignAuctions } = await pool.query(
      'SELECT 1 FROM auctions WHERE lat IS NOT NULL AND lng IS NOT NULL AND country != $1 LIMIT 1',
      [TEST_COUNTRY],
    )
    if (foreignAuctions.length > 0) {
      throw new Error(
        'auctions holds geocoded rows outside this suite\'s test country — this suite\'s candidate query is '
        + 'table-wide and would compute/pollute their auction_geo_metrics. Point TEST_DATABASE_URL at a disposable database.',
      )
    }
    const { rows: foreignEpochs } = await pool.query('SELECT 1 FROM geo_features_epochs LIMIT 1')
    if (foreignEpochs.length > 0) {
      throw new Error(
        'geo_features_epochs already holds rows — it has no per-suite scoping at all, so this suite\'s epoch '
        + 'assertions would be meaningless. Point TEST_DATABASE_URL at a disposable database.',
      )
    }
  })

  afterAll(async () => {
    await pool.query('DELETE FROM auctions WHERE platform = $1', [PLATFORM])
    await pool.query('DELETE FROM geo_features WHERE country = $1', [TEST_COUNTRY])
    await pool.query('DELETE FROM geo_features_epochs')
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM auctions WHERE platform = $1', [PLATFORM])
    await pool.query('DELETE FROM geo_features WHERE country = $1', [TEST_COUNTRY])
    await pool.query('DELETE FROM geo_features_epochs')
    const client = await pool.connect()
    try {
      await seedFixture(client)
    } finally {
      client.release()
    }
  })

  it('computes nearest-distance per category, NULLs a feature beyond its cutoff, and counts tourism density', async () => {
    const client = await pool.connect()
    try {
      const result = await buildAuctionGeoMetrics(drizzle(client), new AbortController().signal)
      expect(result).toMatchObject({ epoch: 1, candidates: 1, computed: 1, skipped: 0 })

      const row = await readMetrics(pool)
      expect(row).toBeDefined()

      // Correctness of the KNN wiring itself, checked against an
      // independently-run reference query rather than a hand-derived meter
      // value (EPSG:3035 distance for a lat/lng offset isn't something to
      // hand-calculate reliably).
      const { rows: ref } = await pool.query<{ dist: number }>(
        `SELECT ST_Distance(f.geom_3035, ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3035))::int AS dist
         FROM geo_features f WHERE f.kind = 'lake' AND f.country = $3`,
        [AUCTION_LNG, AUCTION_LAT, TEST_COUNTRY],
      )
      expect(row!.dist_lake_m).toBe(ref[0]!.dist)
      expect(row!.dist_sea_m).toBeGreaterThan(0)
      expect(row!.dist_river_m).toBeGreaterThan(0)
      expect(row!.dist_mountain_m).toBeGreaterThan(0)

      // Beyond its 100km cutoff: NULL ("nothing within range"), not a huge number.
      expect(row!.dist_airport_m).toBeNull()
      // No ski_area feature seeded at all: same NULL semantics.
      expect(row!.dist_ski_m).toBeNull()

      expect(row!.tourism_density_count).toBe(2)
      expect(row!.attraction_density_count).toBe(2)
      expect(row!.dist_hiking_m).toBeGreaterThan(0)
      expect(row!.features_epoch).toBe(1)

      const { rows: hashRef } = await pool.query<{ hash: string }>(
        `SELECT md5(lat::text || ',' || lng::text) AS hash FROM auctions WHERE platform = $1 AND external_id = $2`,
        [PLATFORM, EXTERNAL_ID],
      )
      expect(row!.point_hash).toBe(hashRef[0]!.hash)
    } finally {
      client.release()
    }
  })

  it('skips an auction whose metrics are already current for this epoch', async () => {
    const client = await pool.connect()
    try {
      const first = await buildAuctionGeoMetrics(drizzle(client), new AbortController().signal)
      expect(first).toMatchObject({ candidates: 1, computed: 1 })
      const firstComputedAt = (await readMetrics(pool))!.computed_at

      const second = await buildAuctionGeoMetrics(drizzle(client), new AbortController().signal)
      expect(second).toMatchObject({ candidates: 0, computed: 0 })
      const secondComputedAt = (await readMetrics(pool))!.computed_at
      expect(secondComputedAt).toEqual(firstComputedAt)
    } finally {
      client.release()
    }
  })

  it('recomputes once the auction is re-geocoded (point_hash changes)', async () => {
    const client = await pool.connect()
    try {
      await buildAuctionGeoMetrics(drizzle(client), new AbortController().signal)
      const before = await readMetrics(pool)

      await client.query('UPDATE auctions SET lat = $1, lng = $2 WHERE platform = $3', [
        AUCTION_LAT + 1,
        AUCTION_LNG + 1,
        PLATFORM,
      ])
      const second = await buildAuctionGeoMetrics(drizzle(client), new AbortController().signal)
      expect(second).toMatchObject({ candidates: 1, computed: 1 })

      const after = await readMetrics(pool)
      expect(after!.point_hash).not.toBe(before!.point_hash)
      // Moved 1° away from every fixture feature: distances must have changed.
      expect(after!.dist_lake_m).not.toBe(before!.dist_lake_m)
    } finally {
      client.release()
    }
  })

  it('deletes the metrics row once the auction loses its geocode', async () => {
    const client = await pool.connect()
    try {
      await buildAuctionGeoMetrics(drizzle(client), new AbortController().signal)
      expect(await readMetrics(pool)).toBeDefined()

      await client.query('UPDATE auctions SET lat = NULL, lng = NULL WHERE platform = $1', [PLATFORM])
      const second = await buildAuctionGeoMetrics(drizzle(client), new AbortController().signal)
      expect(second).toMatchObject({ orphaned: 1, candidates: 0, computed: 0 })

      expect(await readMetrics(pool)).toBeUndefined()
    } finally {
      client.release()
    }
  })

  it('recomputes once geo_features_epochs advances, even with an unchanged position', async () => {
    const client = await pool.connect()
    try {
      await buildAuctionGeoMetrics(drizzle(client), new AbortController().signal)
      await pool.query('INSERT INTO geo_features_epochs (epoch) VALUES (2)')

      const second = await buildAuctionGeoMetrics(drizzle(client), new AbortController().signal)
      expect(second).toMatchObject({ epoch: 2, candidates: 1, computed: 1 })

      const row = await readMetrics(pool)
      expect(row!.features_epoch).toBe(2)
    } finally {
      client.release()
    }
  })

  it('skips a candidate that hits a statement timeout instead of aborting the whole run', async () => {
    const client = await pool.connect()
    try {
      // A second candidate that stays fast, so the run has work left after
      // the slow one.
      await pool.query(
        `INSERT INTO auctions (platform, external_id, country, region, authority, case_number, cancelled, lat, lng)
         VALUES ($1, 'zz-2', $2, 'Test', 'Testbehörde', '1 K 2/26', false, $3, $4)`,
        [PLATFORM, TEST_COUNTRY, AUCTION_LAT, AUCTION_LNG],
      )
      // Stands in for a pathologically slow KNN scan on one candidate (e.g.
      // against the real 700k-row `lake` kind): only this auction's upsert
      // hangs past a short statement_timeout, so a genuine 57014 fires for
      // exactly one candidate while the other stays fast.
      await pool.query(`
        CREATE FUNCTION zz_slow_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.external_id = '${EXTERNAL_ID}' THEN PERFORM pg_sleep(2); END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER zz_slow_candidate BEFORE INSERT ON auction_geo_metrics
          FOR EACH ROW EXECUTE FUNCTION zz_slow_candidate();
      `)
      await client.query("SET statement_timeout = '200'")
      try {
        const result = await buildAuctionGeoMetrics(drizzle(client), new AbortController().signal)
        expect(result).toMatchObject({ candidates: 2, computed: 1, skipped: 1 })
      } finally {
        await client.query('RESET statement_timeout')
        await pool.query('DROP TRIGGER zz_slow_candidate ON auction_geo_metrics; DROP FUNCTION zz_slow_candidate();')
      }

      // The slow candidate has no row at all (its INSERT was cancelled) —
      // the fast one was written normally.
      const { rows } = await pool.query('SELECT external_id FROM auction_geo_metrics WHERE platform = $1', [PLATFORM])
      expect(rows.map((r) => r.external_id)).toEqual(['zz-2'])
    } finally {
      client.release()
    }
  })

  it('stops instead of persisting NULLs when a rebuild supersedes the epoch mid-run', async () => {
    const client = await pool.connect()
    try {
      // A second candidate, so the run still has work left after the first
      // upsert — that's where the epoch guard has to bite.
      await pool.query(
        `INSERT INTO auctions (platform, external_id, country, region, authority, case_number, cancelled, lat, lng)
         VALUES ($1, 'zz-2', $2, 'Test', 'Testbehörde', '1 K 2/26', false, $3, $4)`,
        [PLATFORM, TEST_COUNTRY, AUCTION_LAT, AUCTION_LNG],
      )
      // Stands in for build-geo-features.ts publishing a newer complete epoch
      // (and deleting epoch 1's rows with it) between two upserts of the same
      // run — the window in which every further measurement against epoch 1
      // would come back NULL.
      await pool.query(`
        CREATE FUNCTION zz_supersede_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO geo_features_epochs (epoch) VALUES (2) ON CONFLICT (epoch) DO NOTHING;
          RETURN NEW;
        END $$;
        CREATE TRIGGER zz_supersede_epoch BEFORE INSERT ON auction_geo_metrics
          FOR EACH ROW EXECUTE FUNCTION zz_supersede_epoch();
      `)
      try {
        const result = await buildAuctionGeoMetrics(drizzle(client), new AbortController().signal)
        expect(result).toMatchObject({ epoch: 1, candidates: 2, computed: 1, skipped: 0, epochSuperseded: true })
      } finally {
        await pool.query('DROP TRIGGER zz_supersede_epoch ON auction_geo_metrics; DROP FUNCTION zz_supersede_epoch();')
      }

      // The second auction has no row at all rather than a row full of NULL
      // distances — the next run picks it up again against epoch 2.
      const { rows } = await pool.query('SELECT external_id FROM auction_geo_metrics WHERE platform = $1', [PLATFORM])
      expect(rows).toHaveLength(1)
    } finally {
      client.release()
    }
  })

  it('skips the whole run when no geo_features epoch has completed yet', async () => {
    await pool.query('DELETE FROM geo_features_epochs')
    const client = await pool.connect()
    try {
      const result = await buildAuctionGeoMetrics(drizzle(client), new AbortController().signal)
      expect(result).toMatchObject({ skipped: true })
      expect(await readMetrics(pool)).toBeUndefined()
    } finally {
      client.release()
    }
  })

  it('refuses to run while another process holds the advisory lock', async () => {
    const holder = await pool.connect()
    const client = await pool.connect()
    try {
      // Same key as build-auction-geo-metrics.ts's METRICS_LOCK_KEY.
      await holder.query('SELECT pg_advisory_lock($1)', [4_820_251_205])
      await expect(buildAuctionGeoMetrics(drizzle(client), new AbortController().signal)).rejects.toThrow(/another run/)
      expect(await readMetrics(pool)).toBeUndefined()
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [4_820_251_205])
      holder.release()
      client.release()
    }
  })
})
