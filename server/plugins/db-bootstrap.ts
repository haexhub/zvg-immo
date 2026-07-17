// Ensures server/db/schema.sql has been applied before anything else tries
// to use the database. No-op when NUXT_DATABASE_URL isn't set (see
// server/utils/db.ts). Safe to re-run on every restart — schema.sql is all
// CREATE ... IF NOT EXISTS.

import { runMigrations } from '../utils/db'

export default defineNitroPlugin(() => {
  void runMigrations().catch((err: unknown) => {
    console.error('[db-bootstrap] migration failed:', (err as Error).message)
  })
})
