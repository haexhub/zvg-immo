import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { getOsmImportRequests, requestOsmImport } from './osm-import-requests'

/** Minimal fake Pool: the one INSERT this module issues merges a single
 *  country key into a jsonb object via jsonb_set — emulated directly rather
 *  than reusing app-settings.test.ts's fake pool, whose INSERT dispatch
 *  assumes a whole-value replace, not a per-key merge. */
function makeFakePool() {
  const rows = new Map<string, Record<string, unknown>>()

  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT value FROM app_settings WHERE key =')) {
      const [key] = params as [string]
      return rows.has(key) ? { rows: [{ value: rows.get(key) }] } : { rows: [] }
    }
    if (sql.includes('INSERT INTO app_settings')) {
      const [key, country] = params as [string, string]
      const current = rows.get(key) ?? {}
      rows.set(key, { ...current, [country]: '2026-08-06T21:00:00.000Z' })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected query: ${sql}`)
  }

  return { query, rows } as unknown as Pool & { rows: Map<string, Record<string, unknown>> }
}

describe('osm-import-requests', () => {
  it('returns an empty map when nothing has been requested yet', async () => {
    const db = makeFakePool()
    expect(await getOsmImportRequests(db)).toEqual({})
  })

  it('records a requested country', async () => {
    const db = makeFakePool()
    await requestOsmImport(db, 'de')
    expect(await getOsmImportRequests(db)).toEqual({ de: '2026-08-06T21:00:00.000Z' })
  })

  it('normalizes an uppercase country code', async () => {
    const db = makeFakePool()
    await requestOsmImport(db, 'DE')
    expect(await getOsmImportRequests(db)).toEqual({ de: '2026-08-06T21:00:00.000Z' })
  })

  it('rejects a malformed country code', async () => {
    const db = makeFakePool()
    await expect(requestOsmImport(db, 'germany')).rejects.toThrow()
  })

  it('merges a second request without dropping the first', async () => {
    const db = makeFakePool()
    await requestOsmImport(db, 'de')
    await requestOsmImport(db, 'se')
    expect(await getOsmImportRequests(db)).toEqual({
      de: '2026-08-06T21:00:00.000Z',
      se: '2026-08-06T21:00:00.000Z',
    })
  })

  it('drops malformed entries from a stored value instead of throwing', async () => {
    const db = makeFakePool()
    db.rows.set('osm_import_requests', { de: '2026-08-06T21:00:00.000Z', xx: 123, invalidcode: 'nope' })
    expect(await getOsmImportRequests(db)).toEqual({ de: '2026-08-06T21:00:00.000Z' })
  })
})
