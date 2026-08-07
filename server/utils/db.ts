// Direct Postgres connection to the self-hosted Supabase `db` service, for
// the rare cases that go through `pg` instead of the Supabase JS client
// (bulk history inserts in later phases). Disabled by default (empty
// runtimeConfig.databaseUrl) — mirrors the extractLlm.baseUrl pattern in
// server/tasks/enrich.ts: no config means the feature is off, not a hard
// failure.

import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool, type PoolClient } from 'pg'
import * as schema from '../db/schema'

let pool: Pool | null | undefined
let db: NodePgDatabase<typeof schema> | null | undefined

// ~60s of patience for a concurrently migrating instance to finish.
const MIGRATION_LOCK_ATTEMPTS = 60
const MIGRATION_LOCK_RETRY_MS = 1_000

// Exported for server/tasks/build-geo-features.ts, which needs the same
// config but connects through its own dedicated Pool (see that file) instead
// of the shared one below.
export function readDatabaseUrl(): string | null {
  const url = useRuntimeConfig().databaseUrl as string | undefined
  return url || null
}

// docs/plans/2026-08-04-gis-wp1-index-notfall.md: a single environment/geo
// search hit a Seq Scan over 20 GB and took 16.6s on prod because of an
// invalid index — the pool's client-side `query_timeout` below does not help
// here, since node-pg's read-timeout only stops *waiting* for the reply, it
// never cancels the query on the server. A search query must not be able to
// occupy the server indefinitely regardless of how it got slow, so every
// search query additionally gets a server-enforced statement_timeout.
export const SEARCH_STATEMENT_TIMEOUT_MS = 10_000

export function getPool(): Pool | null {
  if (pool !== undefined) return pool
  const url = readDatabaseUrl()
  // query_timeout guards every query issued through this pool (e.g. the
  // aggregate reads) against an indefinitely stalled Postgres — without it a
  // stuck first read would hang every request that awaits the shared cache
  // promise. Kept strictly above SEARCH_STATEMENT_TIMEOUT_MS, with margin for
  // transport and cleanup, so the server-side statement_timeout always wins
  // the race and cancels with SQLSTATE 57014 first; if this client-side timer
  // fired first instead, pg would reject the query without that SQLSTATE and
  // callers would surface a generic 500 instead of the intended 503.
  const queryTimeoutMs = SEARCH_STATEMENT_TIMEOUT_MS + 5_000
  pool = url ? new Pool({ connectionString: url, query_timeout: queryTimeoutMs }) : null
  return pool
}

/** Shared Drizzle instance over {@link getPool}, for every query outside the raw-SQL search path (see {@link withStatementTimeout}). */
export function getDb(): NodePgDatabase<typeof schema> | null {
  if (db !== undefined) return db
  const p = getPool()
  db = p ? drizzle(p, { schema }) : null
  return db
}

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
  const tx = drizzle(client)
  try {
    await tx.execute(sql`BEGIN`)
    // Bind parameters aren't valid for SET LOCAL, so the value goes in via
    // sql.raw — safe here since it's an internally computed integer, not
    // user input.
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(Math.trunc(timeoutMs)))}`)
    const result = await fn(client)
    await tx.execute(sql`COMMIT`)
    return result
  } catch (err) {
    await tx.execute(sql`ROLLBACK`).catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function runMigrations(): Promise<void> {
  const pool = getPool()
  if (!pool) return
  const client = await pool.connect()
  const tx = drizzle(client)
  let locked = false
  try {
    // All replicas share this session-scoped lock. It prevents two app
    // instances started by the same deployment from applying migrations
    // concurrently and racing on the same DDL. The try-variant is polled
    // rather than blocking on pg_advisory_lock, because the pool's
    // query_timeout would abort a blocking wait and make the second instance
    // of an overlapping deploy fail its migration outright. drizzle-orm's
    // migrate() has no locking of its own (see server/db/migrations/), so
    // this wrapper still carries the whole guarantee.
    for (let attempt = 0; attempt < MIGRATION_LOCK_ATTEMPTS && !locked; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_RETRY_MS))
      const { rows } = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_lock(hashtext('zvg-immo:schema-migrations')) AS locked`,
      )
      locked = rows[0]?.locked === true
    }
    if (!locked) throw new Error('schema migration lock is still held by another instance')
    // Same Dockerfile fallstrick as the old schema.sql read: Nitro's bundler
    // can't see this fs access (readMigrationFiles() reads it dynamically at
    // runtime), so server/db/migrations/ must be copied into the runner image
    // explicitly (see Dockerfile).
    await migrate(tx, { migrationsFolder: join(process.cwd(), 'server/db/migrations') })
  } finally {
    try {
      if (locked) {
        await tx.execute(sql`SELECT pg_advisory_unlock(hashtext('zvg-immo:schema-migrations'))`)
      }
    } finally {
      client.release()
    }
  }
}
