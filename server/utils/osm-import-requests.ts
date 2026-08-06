// Bridges the /settings admin UI to the host-level OSM reimport job
// (ansible role zvg-immo, roles/zvg-immo/templates/osm-import/import.sh.j2).
// That job runs osm2pgsql outside this app's own container (needs host
// disk/curl/apt-get that the app container doesn't have), so there's no
// in-process task to call like enrich/reprocess use. Postgres is the only
// thing both sides already share: the daily job now only (re)loads a
// country automatically when osm_local_elements has zero rows for it
// (first-time bootstrap); an admin click here is what makes it reload an
// already-populated country. Reuses the generic app_settings KV table
// (server/utils/app-settings.ts's pattern) rather than a dedicated table —
// one row per country requested, cleared by import.sh once it starts
// honoring the request.

import type { Pool } from 'pg'

const OSM_IMPORT_REQUESTS_KEY = 'osm_import_requests'
const COUNTRY_CODE_RE = /^[a-z]{2}$/

function coerceOsmImportRequests(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => COUNTRY_CODE_RE.test(entry[0]) && typeof entry[1] === 'string',
    ),
  )
}

export async function getOsmImportRequests(db: Pool): Promise<Record<string, string>> {
  const { rows } = await db.query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [OSM_IMPORT_REQUESTS_KEY],
  )
  return coerceOsmImportRequests(rows[0]?.value)
}

export async function requestOsmImport(db: Pool, country: string): Promise<void> {
  const code = country.trim().toLowerCase()
  if (!COUNTRY_CODE_RE.test(code)) throw new Error('country: ungültiger Wert.')
  // jsonb_set inside the upsert (not a read-modify-write from here) so two
  // admin clicks for different countries can't clobber each other's request.
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, jsonb_build_object($2::text, now()::text), now())
     ON CONFLICT (key) DO UPDATE SET
       value = jsonb_set(coalesce(app_settings.value, '{}'::jsonb), ARRAY[$2::text], to_jsonb(now()::text), true),
       updated_at = now()`,
    [OSM_IMPORT_REQUESTS_KEY, code],
  )
}
