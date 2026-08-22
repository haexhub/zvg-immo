// Search-map "Tourismus-Layer": rebuilds tourism_grid_cells from geo_features
// (WP-4). Unlike build-geo-features.ts this aggregates an already-normalized,
// already-indexed table (a few hundred thousand rows across the tourism-
// relevant kinds, not osm_local_elements' 44.5M raw rows), so a plain
// truncate-and-replace inside one transaction is enough — no epoch/swap
// machinery needed, since there is no long-running window where half the
// categories are rebuilt and half are stale.
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { readDatabaseUrl } from '../utils/db'
import { runExclusiveTask, throwIfTaskAborted } from '../utils/exclusive-task'
import { TOURISM_GRID_CATEGORIES, TOURISM_GRID_CELL_SIZE_M } from '~/lib/tourism-grid-categories'

const BUILD_POOL_MAX_CONNECTIONS = 2
// Generous but bounded ceiling — a GROUP BY over geo_features' tourism kinds
// (idx_geo_features_kind index) is expected to finish in seconds, not
// minutes, but a batch job should never be able to hold a connection forever
// regardless.
const BUILD_STATEMENT_TIMEOUT_MS = 5 * 60 * 1000

export default defineTask({
  meta: {
    name: 'build-tourism-grid',
    description: 'Rebuild tourism_grid_cells from geo_features (search-map tourism layer).',
  },
  async run(): Promise<{ result: BuildTourismGridResult | { skipped: true } }> {
    return await runExclusiveTask('build-tourism-grid', runBuildTourismGrid)
  },
})

async function runBuildTourismGrid(signal: AbortSignal): Promise<{ result: BuildTourismGridResult | { skipped: true } }> {
  const url = readDatabaseUrl()
  if (!url) {
    console.log('[build-tourism-grid] no NUXT_DATABASE_URL configured, skipping')
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
      return { result: await buildTourismGrid(drizzle(client), signal) }
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

export interface BuildTourismGridResult {
  perCategory: Record<string, number>
  durationMs: number
}

/**
 * Exported (rather than folded into runBuildTourismGrid) so tests can drive
 * it directly against a real Postgres connection, same reasoning as
 * build-geo-features.ts's buildGeoFeatures export.
 */
export async function buildTourismGrid(db: NodePgDatabase, signal: AbortSignal): Promise<BuildTourismGridResult> {
  const startedAt = Date.now()
  const perCategory: Record<string, number> = {}

  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE tourism_grid_cells`)
    for (const { category, kinds } of TOURISM_GRID_CATEGORIES) {
      throwIfTaskAborted(signal)
      // Drizzle's sql template spreads a plain JS array into one placeholder
      // per element (for IN-list style usage) rather than binding it as a
      // single array parameter — with kinds.length === 1 that silently
      // produces a bare string, which then fails the ::text[] cast below.
      // Building the array from individually-bound elements sidesteps that
      // entirely, for any kinds.length.
      const kindsArray = sql`ARRAY[${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)}]::text[]`
      const res = await tx.execute(sql`
        INSERT INTO tourism_grid_cells (cell_x, cell_y, category, count)
        SELECT
          floor(ST_X(ST_Centroid(geom_3035)) / ${TOURISM_GRID_CELL_SIZE_M})::int AS cell_x,
          floor(ST_Y(ST_Centroid(geom_3035)) / ${TOURISM_GRID_CELL_SIZE_M})::int AS cell_y,
          ${category} AS category,
          -- Distinct feature identity, not a raw row count: a single large
          -- polygon (e.g. a ski resort or nature reserve) is stored as
          -- several ST_Subdivide fragments in geo_features, which would
          -- otherwise inflate its own cell's intensity.
          COUNT(DISTINCT (osm_type, osm_id, country)) AS cnt
        FROM geo_features
        WHERE kind = ANY(${kindsArray})
        GROUP BY 1, 2
      `)
      perCategory[category] = res.rowCount ?? 0
    }
  })

  const durationMs = Date.now() - startedAt
  console.log(`[build-tourism-grid] done in ${(durationMs / 1000).toFixed(1)}s: ${JSON.stringify(perCategory)}`)
  return { perCategory, durationMs }
}
