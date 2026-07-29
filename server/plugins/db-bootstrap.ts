// Ensures server/db/schema.sql has been applied before anything else tries
// to use the database. No-op when NUXT_DATABASE_URL isn't set (see
// server/utils/db.ts). Safe to re-run on every restart — schema.sql is all
// CREATE ... IF NOT EXISTS.

import { runMigrations } from '../utils/db'

export default defineNitroPlugin((nitroApp) => {
  // Nitro does not await plugin functions, so `await runMigrations()` here
  // would neither delay startup nor fail it — it would just leave an unhandled
  // rejection. Instead every request awaits the shared migration promise: no
  // handler ever runs against a partially migrated database, and a failure
  // keeps surfacing on each request instead of being logged once and lost.
  const migrations = runMigrations()
  migrations.catch((err: unknown) => {
    console.error('[db-bootstrap] migration failed:', (err as Error).message)
  })
  nitroApp.hooks.hook('request', async () => {
    try {
      await migrations
    } catch (err) {
      throw createError({
        statusCode: 503,
        statusMessage: 'Datenbank-Migration fehlgeschlagen',
        data: { detail: (err as Error).message },
      })
    }
  })
})
