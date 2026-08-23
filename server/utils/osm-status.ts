// Shared aggregate behind the live OSM card and the daily status history.
// This keeps a historical row aligned with the live definition of "attached".

import { Pool } from 'pg'
import { ensureEnabledCountriesLoaded, listRegisteredCountries } from '~/server/crawlers/registry'
import { readDatabaseUrl } from './db'
import { getOsmImportRequests } from './osm-import-requests'

export interface OsmImportCountryStatus {
  code: string
  rowCount: number
  requestedAt: string | null
  auctionTotal: number
  attachedAuctions: number
  openAuctions: number
  errorAuctions: number
}

const STATUS_STATEMENT_TIMEOUT_MS = 60_000
const STATUS_CONNECTION_TIMEOUT_MS = 10_000

export async function readOsmStatusByCountry(): Promise<OsmImportCountryStatus[]> {
  await ensureEnabledCountriesLoaded()
  const url = readDatabaseUrl()
  if (!url) return []
  const codes = listRegisteredCountries().map((country) => country.code)
  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: STATUS_CONNECTION_TIMEOUT_MS,
    statement_timeout: STATUS_STATEMENT_TIMEOUT_MS,
  })
  try {
    const [{ rows }, { rows: auctionRows }, requests] = await Promise.all([
      pool.query<{ country: string; count: string }>(
        'SELECT country, count(*) FROM osm_local_elements WHERE country = ANY($1) GROUP BY country', [codes],
      ),
      pool.query<{ country: string; total: string; attached: string }>(
        `SELECT a.country,
                count(*) FILTER (WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL) AS total,
                count(*) FILTER (WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL
                  AND le.enrichment #>> '{locationContext,source,id}' = 'openstreetmap-overpass') AS attached
           FROM auctions a
           LEFT JOIN location_enrichment le ON le.platform = a.platform AND le.external_id = a.external_id
          WHERE a.country = ANY($1) GROUP BY a.country`, [codes],
      ),
      getOsmImportRequests(pool),
    ])
    const counts = new Map(rows.map((row) => [row.country, Number(row.count)]))
    const auctions = new Map(auctionRows.map((row) => [row.country, { total: Number(row.total), attached: Number(row.attached) }]))
    return codes.map((code) => {
      const rowCount = counts.get(code) ?? 0
      const auction = auctions.get(code) ?? { total: 0, attached: 0 }
      const remaining = Math.max(0, auction.total - auction.attached)
      const openAuctions = rowCount > 0 ? remaining : 0
      return { code, rowCount, requestedAt: requests[code] ?? null, auctionTotal: auction.total,
        attachedAuctions: auction.attached, openAuctions, errorAuctions: remaining - openAuctions }
    }).sort((a, b) => a.code.localeCompare(b.code))
  } finally {
    await pool.end()
  }
}
