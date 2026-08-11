// Feeds the country-status OSM card: per enabled country, the raw OSM import
// state plus the number of geocoded auctions whose OSM location context is
// already attached. `requestedAt` is cleared by import.sh.j2 once it starts
// honoring an admin-requested reimport (see osm-import-requests.ts).

import { Pool } from 'pg'
import { ensureEnabledCountriesLoaded, listRegisteredCountries } from '~/server/crawlers/registry'
import { readDatabaseUrl } from '~/server/utils/db'
import { getOsmImportRequests } from '~/server/utils/osm-import-requests'

export interface OsmImportCountryStatus {
  code: string
  /** Imported OSM source objects. This describes the raw import, not auctions. */
  rowCount: number
  requestedAt: string | null
  /** Auctions with usable coordinates in this country. */
  auctionTotal: number
  /** Auctions whose OpenStreetMap location context is already attached. */
  attachedAuctions: number
  /** Eligible auctions awaiting their OSM context. */
  openAuctions: number
  /** Eligible auctions blocked because the country's OSM import is absent. */
  errorAuctions: number
}

// count(*) GROUP BY country now scans osm_local_elements in full (58GB/50M+
// rows after the DE reimport) — comfortably past the shared pool's 15s
// client-side query_timeout (server/utils/db.ts), which must stay tight for
// the search path. A dedicated pool with a generous *server-side*
// statement_timeout (same pattern as build-geo-features.ts) avoids racing
// that budget.
const STATUS_STATEMENT_TIMEOUT_MS = 60_000

export default defineEventHandler(async (event): Promise<{ countries: OsmImportCountryStatus[] }> => {
  await ensureEnabledCountriesLoaded()
  const url = readDatabaseUrl()
  if (!url) return { countries: [] }

  const codes = listRegisteredCountries().map((c) => c.code)
  const pool = new Pool({ connectionString: url, max: 1, statement_timeout: STATUS_STATEMENT_TIMEOUT_MS })
  try {
    const [{ rows }, { rows: auctionRows }, requests] = await Promise.all([
      pool.query<{ country: string; count: string }>(
        'SELECT country, count(*) FROM osm_local_elements WHERE country = ANY($1) GROUP BY country',
        [codes],
      ),
      pool.query<{ country: string; total: string; attached: string }>(
        `SELECT
           a.country,
           count(*) FILTER (WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL) AS total,
           count(*) FILTER (
             WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL
               AND le.enrichment #>> '{locationContext,source,id}' = 'openstreetmap-overpass'
           ) AS attached
         FROM auctions a
         LEFT JOIN location_enrichment le ON le.platform = a.platform AND le.external_id = a.external_id
         WHERE a.country = ANY($1)
         GROUP BY a.country`,
        [codes],
      ),
      getOsmImportRequests(pool),
    ])
    const countByCode = new Map(rows.map((r) => [r.country, Number(r.count)]))
    const auctionsByCode = new Map(auctionRows.map((r) => [r.country, {
      total: Number(r.total),
      attached: Number(r.attached),
    }]))

    return {
      countries: codes
        .map((code) => {
          const rowCount = countByCode.get(code) ?? 0
          const requestedAt = requests[code] ?? null
          const auction = auctionsByCode.get(code) ?? { total: 0, attached: 0 }
          const remaining = Math.max(0, auction.total - auction.attached)
          // Auctions remain blocked until raw OSM data is available. A
          // requested reimport alone does not make enrichment possible.
          const openAuctions = rowCount > 0 ? remaining : 0
          return {
            code,
            rowCount,
            requestedAt,
            auctionTotal: auction.total,
            attachedAuctions: auction.attached,
            openAuctions,
            errorAuctions: remaining - openAuctions,
          }
        })
        .sort((a, b) => a.code.localeCompare(b.code)),
    }
  } finally {
    await pool.end()
  }
})
