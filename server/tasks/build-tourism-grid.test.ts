import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool, PoolClient } from 'pg'
import { vi } from 'vitest'

// Same global stub every server/tasks/*.test.ts needs — buildTourismGrid
// itself never touches Nitro's defineTask, but importing the module at all
// requires the global to exist because of the top-level `export default
// defineTask(...)`.
vi.stubGlobal('defineTask', (definition: unknown) => definition)

const { buildTourismGrid } = await import('./build-tourism-grid')

// Real Postgres, not a mock — this job's correctness is entirely in SQL (the
// floor(x/y / cellSize) binning and the COUNT(DISTINCT ...) dedup), same
// real-Postgres suite convention as build-geo-features.test.ts and
// build-auction-geo-metrics.test.ts; skipped without TEST_DATABASE_URL.
const TEST_DB = process.env.TEST_DATABASE_URL
const describeDb = TEST_DB ? describe : describe.skip

// tourism_grid_cells has no country column at all (unlike geo_features), so
// buildTourismGrid's TRUNCATE is unconditionally table-wide — there is no way
// to scope this suite's ownership check to "our rows only". Point
// TEST_DATABASE_URL at a disposable database; the guard below refuses to run
// against one that already holds any tourism_grid_cells rows. Do not run
// this file concurrently with another suite against the same database.
const TEST_COUNTRY = 'zz-tourism-grid-test'

// Geometries are seeded directly in EPSG:3035 meters (not via
// ST_Transform(..., 4326, 3035) like the geo-metrics fixtures) so each
// fixture's target grid cell is exact arithmetic, not a projection distance
// this test would otherwise have to reason about. CELL_SIZE_M is 10_000.
//
// Cell A = (cellX 10, cellY 20): x in [100_000, 110_000), y in [200_000, 210_000)
// Cell B = (cellX 50, cellY 50): x in [500_000, 510_000), y in [500_000, 510_000)
let nextOsmId = 900_201
function freshOsmId(): number {
  return nextOsmId++
}

async function seedGeoFeature(
  client: PoolClient,
  kind: string,
  osmId: number,
  x: number,
  y: number,
): Promise<void> {
  await client.query(
    `INSERT INTO geo_features (kind, name, country, osm_type, osm_id, geom_3035, features_epoch)
     VALUES ($1, $2, $3, 'way', $4, ST_SetSRID(ST_MakePoint($5, $6), 3035), 1)`,
    [kind, `test-${kind}`, TEST_COUNTRY, osmId, x, y],
  )
}

async function seedFixture(client: PoolClient): Promise<void> {
  // One large ski_area polygon (osm_id below), stored as three
  // ST_Subdivide-style fragments: two centroids inside Cell A, one inside
  // Cell B — proves both halves of the dedup requirement at once: multiple
  // fragments of the SAME feature within one cell must count once, and a
  // feature spanning two cells must still light up both.
  const bigSkiAreaId = freshOsmId()
  await seedGeoFeature(client, 'ski_area', bigSkiAreaId, 101_000, 201_000) // Cell A
  await seedGeoFeature(client, 'ski_area', bigSkiAreaId, 102_000, 202_000) // Cell A (same feature)
  await seedGeoFeature(client, 'ski_area', bigSkiAreaId, 501_000, 501_000) // Cell B (same feature)

  // A second, distinct ski_area feature also in Cell A — must be counted
  // separately from the big polygon above, not collapsed into it.
  await seedGeoFeature(client, 'ski_area', freshOsmId(), 105_000, 205_000) // Cell A

  // hiking_route in Cell A — proves category isolation: must not leak into
  // ski's count for the same cell.
  await seedGeoFeature(client, 'hiking_route', freshOsmId(), 101_500, 201_500) // Cell A

  // A kind that maps to no tourism category at all — must produce zero rows
  // under any category.
  await seedGeoFeature(client, 'sea', freshOsmId(), 101_200, 201_200) // Cell A
}

interface GridRow {
  cell_x: number
  cell_y: number
  category: string
  count: number
}

async function readGrid(pool: Pool): Promise<GridRow[]> {
  const { rows } = await pool.query<GridRow>(
    `SELECT g.cell_x, g.cell_y, g.category, g.count FROM tourism_grid_cells g
     WHERE (g.cell_x, g.cell_y) IN ((10, 20), (50, 50))`,
  )
  return rows
}

describeDb('buildTourismGrid (real Postgres)', () => {
  let pool: Pool
  // Vitest still runs afterAll when beforeAll throws — only run the
  // destructive cleanup once the emptiness guard below has actually passed,
  // so a guard failure never truncates a database this suite doesn't own.
  let ownsTourismGrid = false

  beforeAll(async () => {
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: TEST_DB })
    const { rows: foreignRows } = await pool.query('SELECT 1 FROM tourism_grid_cells LIMIT 1')
    if (foreignRows.length > 0) {
      throw new Error(
        'tourism_grid_cells already holds rows — it has no per-suite scoping at all (buildTourismGrid '
        + 'truncates it unconditionally), so this suite would destroy real data. Point TEST_DATABASE_URL '
        + 'at a disposable database.',
      )
    }
    ownsTourismGrid = true
  })

  afterAll(async () => {
    if (ownsTourismGrid) {
      await pool.query('DELETE FROM geo_features WHERE country = $1', [TEST_COUNTRY])
      await pool.query('TRUNCATE tourism_grid_cells')
    }
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM geo_features WHERE country = $1', [TEST_COUNTRY])
    await pool.query('TRUNCATE tourism_grid_cells')
    const client = await pool.connect()
    try {
      await seedFixture(client)
    } finally {
      client.release()
    }
  })

  it('dedups fragments of one feature, counts distinct features, isolates categories, and spreads across cells', async () => {
    const client = await pool.connect()
    try {
      const result = await buildTourismGrid(drizzle(client), new AbortController().signal)
      expect(result.perCategory.ski).toBeGreaterThanOrEqual(2) // at least our Cell A + Cell B rows
      expect(result.perCategory.hiking).toBeGreaterThanOrEqual(1)

      const rows = await readGrid(pool)
      const cellA = (category: string) => rows.find((r) => r.cell_x === 10 && r.cell_y === 20 && r.category === category)
      const cellB = (category: string) => rows.find((r) => r.cell_x === 50 && r.cell_y === 50 && r.category === category)

      // Two distinct ski_area features in Cell A (the big polygon's two
      // fragments count once, plus the separate one) — not three or four.
      expect(cellA('ski')?.count).toBe(2)
      // The big polygon's third fragment, alone in Cell B.
      expect(cellB('ski')?.count).toBe(1)
      // hiking_route counted under its own category, unaffected by ski's count.
      expect(cellA('hiking')?.count).toBe(1)
      // 'sea' maps to no category — must not surface anywhere.
      expect(rows.some((r) => r.category === ('sea' as string))).toBe(false)
    } finally {
      client.release()
    }
  })

  it('is idempotent: a second run replaces rather than accumulates', async () => {
    const client = await pool.connect()
    try {
      await buildTourismGrid(drizzle(client), new AbortController().signal)
      const firstRun = await readGrid(pool)

      await buildTourismGrid(drizzle(client), new AbortController().signal)
      const secondRun = await readGrid(pool)

      expect(secondRun).toEqual(firstRun)
    } finally {
      client.release()
    }
  })
})
