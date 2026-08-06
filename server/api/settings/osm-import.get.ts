// Feeds SettingsOsmImportCard.vue: per enabled country, how many
// osm_local_elements rows exist right now (proxy for "has this ever loaded")
// and whether an admin-requested reimport is still pending (import.sh.j2
// clears the request once it starts honoring it, see
// server/utils/osm-import-requests.ts).

import { ensureEnabledCountriesLoaded, listRegisteredCountries } from '~/server/crawlers/registry'
import { getOsmImportRequests } from '~/server/utils/osm-import-requests'

export interface OsmImportCountryStatus {
  code: string
  rowCount: number
  requestedAt: string | null
}

export default defineEventHandler(async (event): Promise<{ countries: OsmImportCountryStatus[] }> => {
  await ensureEnabledCountriesLoaded()
  const db = getPool()
  if (!db) return { countries: [] }

  const codes = listRegisteredCountries().map((c) => c.code)
  const [{ rows }, requests] = await Promise.all([
    db.query<{ country: string; count: string }>(
      'SELECT country, count(*) FROM osm_local_elements WHERE country = ANY($1) GROUP BY country',
      [codes],
    ),
    getOsmImportRequests(db),
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
})
