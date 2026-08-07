// Feeds SettingsOsmImportCard.vue: per enabled country, how many
// osm_local_elements rows exist right now (proxy for "has this ever loaded")
// and whether an admin-requested reimport is still pending (import.sh.j2
// clears the request once it starts honoring it, see
// server/utils/osm-import-requests.ts).

import { Pool } from 'pg'
import { ensureEnabledCountriesLoaded, listRegisteredCountries } from '~/server/crawlers/registry'
import { readDatabaseUrl } from '~/server/utils/db'
import { getOsmImportRequests } from '~/server/utils/osm-import-requests'

export interface OsmImportCountryStatus {
  code: string
  rowCount: number
  requestedAt: string | null
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
    const [{ rows }, requests] = await Promise.all([
      pool.query<{ country: string; count: string }>(
        'SELECT country, count(*) FROM osm_local_elements WHERE country = ANY($1) GROUP BY country',
        [codes],
      ),
      getOsmImportRequests(pool),
    ])
    const countByCode = new Map(rows.map((r) => [r.country, Number(r.count)]))

    return {
      countries: codes
        .map((code) => ({
          code,
          rowCount: countByCode.get(code) ?? 0,
          requestedAt: requests[code] ?? null,
        }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    }
  } finally {
    await pool.end()
  }
})
