import { defineConfig } from 'drizzle-kit'

// Baseline note: this is a greenfield schema (see
// docs/plans/2026-08-04-gis-wp0-schema-neuaufbau.md) — server/db/schema.sql
// is retired in favor of these migrations; server/plugins/db-bootstrap.ts
// stays, just applying server/db/migrations/ via drizzle-orm's migrator
// (server/utils/db.ts) instead of the old idempotent schema.sql. `generate`
// only diffs server/db/schema/* against server/db/migrations/meta's last
// snapshot; it never touches a live database, so dbCredentials below is a
// placeholder wherever NUXT_DATABASE_URL isn't set — only `migrate`/`studio`
// need a real connection.
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema/index.ts',
  out: './server/db/migrations',
  dbCredentials: {
    url: process.env.NUXT_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres',
  },
})
