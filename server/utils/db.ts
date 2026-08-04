// Direct Postgres connection to the self-hosted Supabase `db` service, for
// the rare cases that go through `pg` instead of the Supabase JS client
// (bulk history inserts in later phases). Disabled by default (empty
// runtimeConfig.databaseUrl) — mirrors the extractLlm.baseUrl pattern in
// server/tasks/enrich.ts: no config means the feature is off, not a hard
// failure.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'

let pool: Pool | null | undefined

// ~60s of patience for a concurrently migrating instance to finish.
const MIGRATION_LOCK_ATTEMPTS = 60
const MIGRATION_LOCK_RETRY_MS = 1_000

function readDatabaseUrl(): string | null {
  const url = useRuntimeConfig().databaseUrl as string | undefined
  return url || null
}

export function getPool(): Pool | null {
  if (pool !== undefined) return pool
  const url = readDatabaseUrl()
  // query_timeout guards every query issued through this pool (e.g. the
  // aggregate reads) against an indefinitely stalled
  // Postgres — without it a stuck first read would hang every request that
  // awaits the shared cache promise.
  pool = url ? new Pool({ connectionString: url, query_timeout: 10_000 }) : null
  return pool
}

// docs/plans/2026-08-04-gis-wp1-index-notfall.md: a single environment/geo
// search hit a Seq Scan over 20 GB and took 16.6s on prod because of an
// invalid index — the pool's client-side `query_timeout` above does not help
// here, since node-pg's read-timeout only stops *waiting* for the reply, it
// never cancels the query on the server. A search query must not be able to
// occupy the server indefinitely regardless of how it got slow, so every
// search query additionally gets a server-enforced statement_timeout.
export const SEARCH_STATEMENT_TIMEOUT_MS = 10_000

/** Postgres SQLSTATE for a statement cancelled by `statement_timeout`. */
const STATEMENT_TIMEOUT_SQLSTATE = '57014'

export function isStatementTimeoutError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === STATEMENT_TIMEOUT_SQLSTATE
  )
}

/**
 * Runs `fn` against a single connection checked out of the pool, with a
 * `statement_timeout` scoped to just this transaction via `SET LOCAL`. Using
 * plain `SET` here would leak the timeout onto the pooled connection for
 * every future, unrelated request it happens to serve next — `SET LOCAL`
 * resets automatically at COMMIT/ROLLBACK.
 *
 * On timeout Postgres cancels the statement and raises SQLSTATE 57014
 * (`isStatementTimeoutError`); callers translate that into a 503 instead of
 * letting it surface as a generic 500.
 */
export async function withStatementTimeout<T>(
  db: Pool,
  timeoutMs: number,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
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
    // The try-variant is polled rather than blocking on pg_advisory_lock,
    // because the pool's query_timeout would abort a blocking wait and make the
    // second instance of an overlapping deploy fail its migration outright.
    for (let attempt = 0; attempt < MIGRATION_LOCK_ATTEMPTS && !locked; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_RETRY_MS))
      const { rows } = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext('zvg-immo:schema-migrations')) AS locked`,
      )
      locked = rows[0]?.locked === true
    }
    if (!locked) throw new Error('schema migration lock is still held by another instance')
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
