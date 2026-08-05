import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
}

interface MetricsRow {
  dist_sea_m: number | null
  dist_lake_m: number | null
  dist_river_m: number | null
  dist_mountain_m: number | null
  dist_airport_m: number | null
  dist_ski_m: number | null
  tourism_density_count: number | null
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
      const result = await buildAuctionGeoMetrics(client, new AbortController().signal)
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
      const first = await buildAuctionGeoMetrics(client, new AbortController().signal)
      expect(first).toMatchObject({ candidates: 1, computed: 1 })
      const firstComputedAt = (await readMetrics(pool))!.computed_at

      const second = await buildAuctionGeoMetrics(client, new AbortController().signal)
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
      await buildAuctionGeoMetrics(client, new AbortController().signal)
      const before = await readMetrics(pool)

      await client.query('UPDATE auctions SET lat = $1, lng = $2 WHERE platform = $3', [
        AUCTION_LAT + 1,
        AUCTION_LNG + 1,
        PLATFORM,
      ])
      const second = await buildAuctionGeoMetrics(client, new AbortController().signal)
      expect(second).toMatchObject({ candidates: 1, computed: 1 })

      const after = await readMetrics(pool)
      expect(after!.point_hash).not.toBe(before!.point_hash)
      // Moved 1° away from every fixture feature: distances must have changed.
      expect(after!.dist_lake_m).not.toBe(before!.dist_lake_m)
    } finally {
      client.release()
    }
  })

  it('recomputes once geo_features_epochs advances, even with an unchanged position', async () => {
    const client = await pool.connect()
    try {
      await buildAuctionGeoMetrics(client, new AbortController().signal)
      await pool.query('INSERT INTO geo_features_epochs (epoch) VALUES (2)')

      const second = await buildAuctionGeoMetrics(client, new AbortController().signal)
      expect(second).toMatchObject({ epoch: 2, candidates: 1, computed: 1 })

      const row = await readMetrics(pool)
      expect(row!.features_epoch).toBe(2)
    } finally {
      client.release()
    }
  })

  it('skips the whole run when no geo_features epoch has completed yet', async () => {
    await pool.query('DELETE FROM geo_features_epochs')
    const client = await pool.connect()
    try {
      const result = await buildAuctionGeoMetrics(client, new AbortController().signal)
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
      await expect(buildAuctionGeoMetrics(client, new AbortController().signal)).rejects.toThrow(/another run/)
      expect(await readMetrics(pool)).toBeUndefined()
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [4_820_251_205])
      holder.release()
      client.release()
    }
  })
})
