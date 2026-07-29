// Ensures server/db/schema.sql has been applied before anything else tries
// to use the database. No-op when NUXT_DATABASE_URL isn't set (see
// server/utils/db.ts). Safe to re-run on every restart — schema.sql is all
// CREATE ... IF NOT EXISTS.

import { runMigrations } from '../utils/db'

export default defineNitroPlugin(async () => {
  // Do not advertise a ready application against a partially migrated
  // database. A configured database is mandatory for the serving/archive
  // paths, so migration failure must fail startup visibly.
  await runMigrations()
})
