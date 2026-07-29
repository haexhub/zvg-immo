// Direct Postgres connection to the self-hosted Supabase `db` service, for
// the rare cases that go through `pg` instead of the Supabase JS client
// (bulk history inserts in later phases). Disabled by default (empty
// runtimeConfig.databaseUrl) — mirrors the extractLlm.baseUrl pattern in
// server/tasks/enrich.ts: no config means the feature is off, not a hard
// failure.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'

let pool: Pool | null | undefined

function readDatabaseUrl(): string | null {
  const url = useRuntimeConfig().databaseUrl as string | undefined
  return url || null
}

export function getPool(): Pool | null {
  if (pool !== undefined) return pool
  const url = readDatabaseUrl()
  // query_timeout guards every query issued through this pool (e.g. the
  // extraction-cache full-table load) against an indefinitely stalled
  // Postgres — without it a stuck first read would hang every request that
  // awaits the shared cache promise.
  pool = url ? new Pool({ connectionString: url, query_timeout: 10_000 }) : null
  return pool
}

export async function runMigrations(): Promise<void> {
  const db = getPool()
  if (!db) return
  const schema = await readFile(join(process.cwd(), 'server/db/schema.sql'), 'utf8')
  const client = await db.connect()
  let locked = false
  try {
    // All replicas share this session-scoped lock. It prevents two app
    // instances started by the same deployment from applying the large,
    // idempotent schema file concurrently and racing on conditional DDL.
    await client.query(`SELECT pg_advisory_lock(hashtext('zvg-immo:schema-migrations'))`)
    locked = true
    await client.query(schema)
  } finally {
    try {
      if (locked) {
        await client.query(`SELECT pg_advisory_unlock(hashtext('zvg-immo:schema-migrations'))`)
      }
    } finally {
      client.release()
    }
  }
}
