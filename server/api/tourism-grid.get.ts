// GET /api/tourism-grid — bbox-scoped GeoJSON for the search-map "Tourismus-
// Layer" (grid built nightly by server/tasks/build-tourism-grid.ts).
// Deliberately NOT unscoped like /api/auctions-geo: an unbounded query against
// this table would repeat the statement-timeout/OOM history this project has
// already had with other geo-data endpoints.
import { sql } from 'drizzle-orm'
import { getDb } from '~/server/utils/db'
import { finiteNumber } from '~/lib/auction-search-filter-contract'
import { isTourismCategory, TOURISM_GRID_CELL_SIZE_M } from '~/lib/tourism-grid-categories'

// A single category's grid rarely reaches this many cells even at country
// zoom — this is a backstop against a world-zoomed-out viewport asking for
// the whole table. Rows come back darkest-first (highest count), so a capped
// response still shows the most meaningful cells instead of an arbitrary
// subset.
const MAX_CELLS = 5000

export interface TourismGridCell {
  cellX: number
  cellY: number
  count: number
  /** GeoJSON Polygon, EPSG:4326 — the cell's bounds reprojected back from EPSG:3035. */
  geometry: unknown
}

export interface TourismGridResponse {
  category: string
  cells: TourismGridCell[]
  truncated: boolean
}

export default defineEventHandler(async (event): Promise<TourismGridResponse> => {
  const db = getDb()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'Datenbank ist nicht konfiguriert' })
  }

  const query = getQuery(event)
  const category = typeof query.category === 'string' ? query.category : ''
  if (!isTourismCategory(category)) {
    throw createError({ statusCode: 400, statusMessage: 'Ungültige oder fehlende Kategorie' })
  }

  const north = finiteNumber(query.north)
  const south = finiteNumber(query.south)
  const east = finiteNumber(query.east)
  const west = finiteNumber(query.west)
  if (
    north == null || south == null || east == null || west == null
    || Math.abs(north) > 90 || Math.abs(south) > 90
    || Math.abs(east) > 180 || Math.abs(west) > 180
    || south > north || west > east
  ) {
    throw createError({ statusCode: 400, statusMessage: 'Ungültiger oder fehlender Kartenausschnitt (north/south/east/west)' })
  }

  // Bbox corners don't transform to an exact rectangle in EPSG:3035, so this
  // envelope is a conservative pre-filter (used only to pick a cellX/cellY
  // range for the indexed range scan below) — the cells actually returned
  // are reprojected individually further down, which is what the client
  // renders. ST_Segmentize densifies the edges before the transform: without
  // it, ST_Transform only maps the four corners, and a large viewport's
  // projected edges can bulge past the corner-only envelope in EPSG:3035,
  // silently dropping valid cells near the edge.
  const { rows: envelope } = await db.execute<{ min_x: number; max_x: number; min_y: number; max_y: number }>(sql`
    SELECT
      floor(ST_XMin(bbox.geom) / ${TOURISM_GRID_CELL_SIZE_M})::int AS min_x,
      floor(ST_XMax(bbox.geom) / ${TOURISM_GRID_CELL_SIZE_M})::int AS max_x,
      floor(ST_YMin(bbox.geom) / ${TOURISM_GRID_CELL_SIZE_M})::int AS min_y,
      floor(ST_YMax(bbox.geom) / ${TOURISM_GRID_CELL_SIZE_M})::int AS max_y
    FROM (
      SELECT ST_Transform(
        ST_Segmentize(ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326), 0.5),
        3035
      ) AS geom
    ) bbox
  `)
  const bounds = envelope[0]
  if (!bounds) {
    return { category, cells: [], truncated: false }
  }

  const { rows } = await db.execute<{ cell_x: number; cell_y: number; count: number; geom: string }>(sql`
    SELECT cell_x, cell_y, count,
      ST_AsGeoJSON(ST_Transform(ST_MakeEnvelope(
        cell_x * ${TOURISM_GRID_CELL_SIZE_M}, cell_y * ${TOURISM_GRID_CELL_SIZE_M},
        (cell_x + 1) * ${TOURISM_GRID_CELL_SIZE_M}, (cell_y + 1) * ${TOURISM_GRID_CELL_SIZE_M}, 3035
      ), 4326)) AS geom
    FROM tourism_grid_cells
    WHERE category = ${category}
      AND cell_x BETWEEN ${bounds.min_x} AND ${bounds.max_x}
      AND cell_y BETWEEN ${bounds.min_y} AND ${bounds.max_y}
    ORDER BY count DESC
    LIMIT ${MAX_CELLS + 1}
  `)

  const truncated = rows.length > MAX_CELLS
  const cells: TourismGridCell[] = rows.slice(0, MAX_CELLS).map((r) => ({
    cellX: r.cell_x,
    cellY: r.cell_y,
    count: r.count,
    geometry: JSON.parse(r.geom),
  }))

  // Derived, nightly-rebuilt data — a short cache trims repeat requests from
  // panning/zooming within the same session without risking staleness.
  setResponseHeader(event, 'cache-control', 'public, max-age=300')
  return { category, cells, truncated }
})
